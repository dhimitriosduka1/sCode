import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    parseClusterAccountOverviewOutput,
    parseClusterHogsOutput,
    parseClusterLeaderboardOutput,
    parsePartitionUsageOutput,
    parseScontrolNodeOutput,
    getNodeIdleGpusByType,
} from '../slurmService';
import { formatPartitionUsageMemoryBreakdown } from '../partitionUsageRanking';

describe('parseClusterLeaderboardOutput', () => {
    it('tracks only GPU jobs and excludes CPU-only users', () => {
        const entries = parseClusterLeaderboardOutput([
            'alice|mswk_inst|gres/gpu:2|cpu=16,mem=128G,node=1,billing=16,gres/gpu=2|',
            'alice|cpu_inst|N/A|cpu=4,mem=16G,node=1,billing=4|',
            'bob|mcs_inst|gres/gpu:a100:4|cpu=32,mem=256G,node=1,billing=32,gres/gpu=4,gres/gpu:a100=4|',
            'bob|mcs_inst|gres/gpu:h200:1|cpu=8,mem=64G,node=1,billing=8,gres/gpu=1,gres/gpu:h200=1|',
            'carol|cpu_inst|N/A|cpu=1,mem=4G,node=1,billing=1|',
        ].join('\n'));

        entries.sort((a, b) => a.username.localeCompare(b.username));

        assert.deepEqual(entries, [
            {
                username: 'alice',
                accounts: ['mswk_inst'],
                gpuCount: 2,
                gpuJobCount: 1,
                gpuTypes: [{ type: 'generic', count: 2 }],
            },
            {
                username: 'bob',
                accounts: ['mcs_inst'],
                gpuCount: 5,
                gpuJobCount: 2,
                gpuTypes: [
                    { type: 'a100', count: 4 },
                    { type: 'h200', count: 1 },
                ],
            },
        ]);
    });

    it('collects distinct Slurm accounts and GPU types for GPU jobs by user', () => {
        const entries = parseClusterLeaderboardOutput([
            'mixed|z_inst|gres/gpu:1|cpu=8,node=1,gres/gpu=1|',
            'mixed|a_inst|gres/gpu:2|cpu=16,node=1,gres/gpu=2|',
            'mixed|a_inst|gres/gpu:1|cpu=8,node=1,gres/gpu=1|',
            'mixed|a_inst|gres/gpu:a100:4,gres/gpu:h200:1|cpu=40,node=1,gres/gpu=5,gres/gpu:a100=4,gres/gpu:h200=1|',
            'mixed|cpu_inst|N/A|cpu=4,node=1|',
        ].join('\n'));

        assert.deepEqual(entries, [
            {
                username: 'mixed',
                accounts: ['a_inst', 'z_inst'],
                gpuCount: 9,
                gpuJobCount: 4,
                gpuTypes: [
                    { type: 'a100', count: 4 },
                    { type: 'generic', count: 4 },
                    { type: 'h200', count: 1 },
                ],
            },
        ]);
    });

    it('counts the GPUs Slurm allocated, not the per-node request times the node count', () => {
        // The last two jobs were submitted with both --gpus-per-node=4 and
        // --gres=gpu:4, which lists the request twice; Slurm still allocates
        // 4 GPUs per node.
        assert.deepEqual(parseClusterLeaderboardOutput([
            'dduka|mpi_gpu|gres/gpu:4|cpu=4096,mem=61696G,node=128,billing=4096,gres/gpu=512|',
            'dduka|mpi_gpu|gres/gpu:4,gres/gpu:4|cpu=352,mem=5434000M,node=11,billing=352,gres/gpu=44|',
            'dduka|mpi_gpu|gres/gpu:4,gres/gpu:4|cpu=2048,mem=30875G,node=64,billing=2048,gres/gpu=256|',
        ].join('\n')), [
            {
                username: 'dduka',
                accounts: ['mpi_gpu'],
                gpuCount: 812,
                gpuJobCount: 3,
                gpuTypes: [{ type: 'generic', count: 812 }],
            },
        ]);
    });

    it('counts GPUs requested per job or per task, which the per-node request leaves out', () => {
        assert.deepEqual(parseClusterLeaderboardOutput(
            'alice|vision_lab|N/A|cpu=64,mem=512G,node=2,billing=64,gres/gpu=16|',
        ), [
            {
                username: 'alice',
                accounts: ['vision_lab'],
                gpuCount: 16,
                gpuJobCount: 1,
                gpuTypes: [{ type: 'generic', count: 16 }],
            },
        ]);
    });

    it('names GPU types from the allocation, or from the request when the allocation has none', () => {
        assert.deepEqual(parseClusterLeaderboardOutput([
            'alice|vision_lab|gres/gpu:4|cpu=32,node=1,gres/gpu=4,gres/gpu:l40s=4|',
            'alice|vision_lab|gres/gpu:h100:4|cpu=64,node=2,gres/gpu=8|',
            'alice|vision_lab|gres/gpu:a100:1,gres/gpu:h100:1|cpu=16,node=1,gres/gpu=2|',
        ].join('\n')), [
            {
                username: 'alice',
                accounts: ['vision_lab'],
                gpuCount: 14,
                gpuJobCount: 3,
                gpuTypes: [
                    { type: 'h100', count: 8 },
                    { type: 'l40s', count: 4 },
                    { type: 'generic', count: 2 },
                ],
            },
        ]);
    });

    it('returns an empty leaderboard for empty squeue output', () => {
        assert.deepEqual(parseClusterLeaderboardOutput(''), []);
        assert.deepEqual(parseClusterLeaderboardOutput('\n\n'), []);
    });
});

describe('parseClusterAccountOverviewOutput', () => {
    it('aggregates running GPU jobs by Slurm account', () => {
        const entries = parseClusterAccountOverviewOutput([
            'alice|vision_lab|gres/gpu:a100:2|cpu=16,node=1,gres/gpu=2|',
            'alice|local_inst|gres/gpu:h200:1|cpu=8,node=1,gres/gpu=1|',
            'bob|vision_lab|gres/gpu:a100:4|cpu=32,node=1,gres/gpu=4|',
            'carol|cpu_inst|N/A|cpu=4,node=1|',
        ].join('\n'));

        assert.deepEqual(entries, [
            {
                account: 'vision_lab',
                gpuCount: 6,
                gpuJobCount: 2,
                gpuTypes: [{ type: 'a100', count: 6 }],
                users: [
                    { username: 'bob', gpuCount: 4, gpuJobCount: 1 },
                    { username: 'alice', gpuCount: 2, gpuJobCount: 1 },
                ],
            },
            {
                account: 'local_inst',
                gpuCount: 1,
                gpuJobCount: 1,
                gpuTypes: [{ type: 'h200', count: 1 }],
                users: [{ username: 'alice', gpuCount: 1, gpuJobCount: 1 }],
            },
        ]);
    });

    it('groups GPU jobs without a Slurm account as unknown', () => {
        assert.deepEqual(parseClusterAccountOverviewOutput('alice|(null)|gres/gpu:2|cpu=16,node=1,gres/gpu=2|'), [
            {
                account: 'unknown',
                gpuCount: 2,
                gpuJobCount: 1,
                gpuTypes: [{ type: 'generic', count: 2 }],
                users: [{ username: 'alice', gpuCount: 2, gpuJobCount: 1 }],
            },
        ]);
    });

    it('counts the GPUs Slurm allocated, not the per-node request times the node count', () => {
        assert.deepEqual(parseClusterAccountOverviewOutput([
            'dduka|mpi_gpu|gres/gpu:4|cpu=4096,mem=61696G,node=128,billing=4096,gres/gpu=512|',
            'dduka|mpi_gpu|gres/gpu:4,gres/gpu:4|cpu=352,mem=5434000M,node=11,billing=352,gres/gpu=44|',
            'dduka|mpi_gpu|gres/gpu:4,gres/gpu:4|cpu=2048,mem=30875G,node=64,billing=2048,gres/gpu=256|',
        ].join('\n')), [
            {
                account: 'mpi_gpu',
                gpuCount: 812,
                gpuJobCount: 3,
                gpuTypes: [{ type: 'generic', count: 812 }],
                users: [{ username: 'dduka', gpuCount: 812, gpuJobCount: 3 }],
            },
        ]);
    });
});

describe('parseClusterHogsOutput', () => {
    it('ranks top GPU hogs by the GPUs Slurm allocated', () => {
        // Doubling dduka's per-node request would put them ahead (176 GPUs);
        // Slurm allocated them 88.
        assert.deepEqual(parseClusterHogsOutput([
            'dduka|mpi_gpu|gres/gpu:4,gres/gpu:4|cpu=352,node=11,gres/gpu=44|',
            'dduka|mpi_gpu|gres/gpu:4,gres/gpu:4|cpu=352,node=11,gres/gpu=44|',
            'dduka|mpi_gpu|N/A|cpu=4,node=1|',
            'alice|vision_lab|gres/gpu:8|cpu=384,node=12,gres/gpu=96|',
        ].join('\n')), {
            topJobHog: { username: 'dduka', jobCount: 3 },
            topGpuHog: { username: 'alice', gpuCount: 96 },
        });
    });
});

describe('parseScontrolNodeOutput', () => {
    it('parses AllocTRES GPU counts per node', () => {
        const stdout = [
            'NodeName=gpu-01 Arch=x86_64 CoresPerSocket=64',
            ' OS=Linux 5.15.0',
            ' CfgTRES=cpu=192,mem=2048G,gres/gpu=8,gres/gpu:h200=8',
            ' AllocTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:h200=4',
            'NodeName=gpu-02 Arch=x86_64',
            ' CfgTRES=cpu=192,mem=2048G,gres/gpu=8,gres/gpu:h200=8',
            ' AllocTRES=cpu=192,mem=2048G,gres/gpu=8,gres/gpu:h200=8',
            'NodeName=gpu-03 Arch=x86_64',
            ' CfgTRES=cpu=192,mem=2048G,gres/gpu=8,gres/gpu:h200=8',
            ' AllocTRES=',
        ].join('\n');

        const result = parseScontrolNodeOutput(stdout);
        assert.equal(result.get('gpu-01'), 4);
        assert.equal(result.get('gpu-02'), 8);
        assert.equal(result.get('gpu-03'), 0);
    });

    it('handles nodes with no AllocTRES field (fully idle)', () => {
        const stdout = [
            'NodeName=idle-node Arch=x86_64',
            ' CfgTRES=cpu=64,mem=512G,gres/gpu=4,gres/gpu:a100=4',
            ' State=IDLE',
        ].join('\n');

        const result = parseScontrolNodeOutput(stdout);
        assert.equal(result.get('idle-node'), 0);
    });

    it('counts GPUs regardless of allocation method (generic + typed)', () => {
        // When a job uses --gpus-per-node or TRES, AllocTRES may include both
        // gres/gpu=N (generic) and gres/gpu:type=N. parseGpuAllocations deduplicates.
        const stdout = [
            'NodeName=mixed-01 Arch=x86_64',
            ' CfgTRES=cpu=96,mem=1000G,gres/gpu=8,gres/gpu:b200=8',
            ' AllocTRES=cpu=96,mem=1000G,gres/gpu=8,gres/gpu:b200=8',
        ].join('\n');

        const result = parseScontrolNodeOutput(stdout);
        assert.equal(result.get('mixed-01'), 8); // not 16 — deduplication
    });

    it('returns an empty map for empty input', () => {
        assert.equal(parseScontrolNodeOutput('').size, 0);
    });
});

describe('parsePartitionUsageOutput', () => {
    // Helper to build a minimal scontrol block for a node
    function scontrolBlock(nodeName: string, allocGpus: number, gpuType = 'a100'): string {
        const allocTres = allocGpus > 0
            ? `cpu=64,mem=512G,gres/gpu=${allocGpus},gres/gpu:${gpuType}=${allocGpus}`
            : '';
        return [
            `NodeName=${nodeName} Arch=x86_64`,
            ` CfgTRES=cpu=64,mem=512G,gres/gpu=4,gres/gpu:${gpuType}=4`,
            ` AllocTRES=${allocTres}`,
        ].join('\n');
    }

    it('aggregates GPU partition capacity and queue pressure', () => {
        // sinfo -N --noheader --format="%N|%P|%T|%G"
        const sinfoNode = [
            'n01|gpu*|allocated|gpu:a100:4',
            'n02|gpu*|allocated|gpu:a100:4',
            'n03|gpu*|idle|gpu:a100:4',
            'n04|gpu*|idle|gpu:a100:4',
            'n05|gpu*|drain|gpu:a100:4',
            'h01|h200|allocated|gpu:h200:4',
            'h02|h200|idle|gpu:h200:4',
            'h03|h200|idle|gpu:h200:4',
            'h04|h200|idle|gpu:h200:4',
            'c01|cpu|allocated|(null)',
        ].join('\n');

        const scontrol = [
            scontrolBlock('n01', 2),
            scontrolBlock('n02', 0),
            scontrolBlock('n03', 0),
            scontrolBlock('n04', 0),
            scontrolBlock('n05', 0),
            scontrolBlock('h01', 1, 'h200'),
            scontrolBlock('h02', 0, 'h200'),
            scontrolBlock('h03', 0, 'h200'),
            scontrolBlock('h04', 0, 'h200'),
        ].join('\n');

        // squeue --noheader --format="%P|%t" (counts only)
        const squeue = [
            'gpu|R',
            'gpu|PD',
            'h200|R',
        ].join('\n');

        const { entries, clusterAllocatedGpus, clusterAvailableGpus } = parsePartitionUsageOutput(sinfoNode, scontrol, squeue);

        assert.deepEqual(entries, [
            {
                partition: 'gpu',
                isDefault: true,
                totalNodes: 5,
                allocatedNodes: 2,
                idleNodes: 2,
                otherNodes: 1,
                totalGpus: 20,
                availableGpus: 16,
                allocatedGpus: 2,
                idleGpus: 14,
                runningJobs: 1,
                pendingJobs: 1,
                gpuTypes: [{ type: 'a100', count: 20 }],
                idleGpusByType: [{ type: 'a100', count: 14 }],
            },
            {
                partition: 'h200',
                isDefault: false,
                totalNodes: 4,
                allocatedNodes: 1,
                idleNodes: 3,
                otherNodes: 0,
                totalGpus: 16,
                availableGpus: 16,
                allocatedGpus: 1,
                idleGpus: 15,
                runningJobs: 1,
                pendingJobs: 0,
                gpuTypes: [{ type: 'h200', count: 16 }],
                idleGpusByType: [{ type: 'h200', count: 15 }],
            },
        ]);
        
        assert.equal(clusterAllocatedGpus, 3);
        assert.equal(clusterAvailableGpus, 32);
    });

    it('treats node state suffix flags and GRES socket-binding annotations as real Slurm emits them', () => {
        // Real sinfo output carries a trailing flag character on the state
        // (e.g. "mixed-" = MIXED + backfill-planned, "idle~" = powered down,
        // "allocated+" = allocated + completing) and a "(S:0-1)" socket
        // binding suffix on typed GRES. Neither should break bucketing or counts.
        const sinfoNode = [
            'n01|gpu|mixed-|gpu:a100:4(S:0-1)',
            'n02|gpu|allocated+|gpu:a100:4(S:0-1)',
            'n03|gpu|idle~|gpu:a100:4(S:0-1)',
        ].join('\n');

        const scontrol = [
            scontrolBlock('n01', 2),
            scontrolBlock('n02', 4),
            scontrolBlock('n03', 0),
        ].join('\n');

        const { entries } = parsePartitionUsageOutput(sinfoNode, scontrol, '');

        assert.deepEqual(entries, [{
            partition: 'gpu',
            isDefault: false,
            totalNodes: 3,
            allocatedNodes: 2,
            idleNodes: 1,
            otherNodes: 0,
            totalGpus: 12,
            availableGpus: 12,
            allocatedGpus: 6,
            idleGpus: 6,
            runningJobs: 0,
            pendingJobs: 0,
            gpuTypes: [{ type: 'a100', count: 12 }],
            idleGpusByType: [{ type: 'a100', count: 6 }],
        }]);
    });

    it('counts idle GPUs per type in a partition mixing GPU types', () => {
        const sinfoNode = [
            'a01|gpu|allocated|gpu:a100:4',
            'a02|gpu|idle|gpu:a100:4',
            'h01|gpu|allocated|gpu:h200:8',
            'h02|gpu|drain|gpu:h200:8',
        ].join('\n');
        const scontrol = [
            scontrolBlock('a01', 3, 'a100'),
            scontrolBlock('a02', 0, 'a100'),
            scontrolBlock('h01', 8, 'h200'),
            scontrolBlock('h02', 0, 'h200'),
        ].join('\n');

        const [entry] = parsePartitionUsageOutput(sinfoNode, scontrol, '').entries;

        // a100: 8 available, 3 allocated; h200: the drained node's 8 aren't available, the other 8 are all taken
        assert.deepEqual(entry.idleGpusByType, [{ type: 'a100', count: 5 }, { type: 'h200', count: 0 }]);
        assert.equal(entry.idleGpus, 5);
    });

    it('filters out CPU-only partitions', () => {
        const sinfoNode = 'c01|cpu|allocated|(null)\nc02|cpu|idle|(null)';
        const scontrol = [
            'NodeName=c01 Arch=x86_64\n CfgTRES=cpu=64,mem=512G\n AllocTRES=cpu=32,mem=256G',
            'NodeName=c02 Arch=x86_64\n CfgTRES=cpu=64,mem=512G\n AllocTRES=',
        ].join('\n');
        assert.deepEqual(parsePartitionUsageOutput(sinfoNode, scontrol, 'cpu|R\ncpu|PD').entries, []);
    });

    it('counts pending jobs across comma-separated GPU partition choices', () => {
        const sinfoNode = [
            'n01|gpu|idle|gpu:a100:4',
            'n02|gpu|idle|gpu:a100:4',
            'h01|h200|idle|gpu:h200:4',
            'h02|h200|idle|gpu:h200:4',
        ].join('\n');
        const scontrol = [
            scontrolBlock('n01', 0), scontrolBlock('n02', 0),
            scontrolBlock('h01', 0, 'h200'), scontrolBlock('h02', 0, 'h200'),
        ].join('\n');

        const { entries } = parsePartitionUsageOutput(sinfoNode, scontrol, 'gpu,h200|PD');

        assert.deepEqual(entries.map(e => ({ partition: e.partition, pendingJobs: e.pendingJobs, runningJobs: e.runningJobs })), [
            { partition: 'gpu', pendingJobs: 1, runningJobs: 0 },
            { partition: 'h200', pendingJobs: 1, runningJobs: 0 },
        ]);
    });

    it('attributes overlapping-partition node GPU allocation to all partitions', () => {
        // node n01 belongs to both "gpu" and "gpudev" (same physical node)
        // Both partitions should report its 4 allocated GPUs.
        const sinfoNode = [
            'n01|gpu|allocated|gpu:a100:4',
            'n01|gpudev|allocated|gpu:a100:4',
        ].join('\n');
        const scontrol = scontrolBlock('n01', 4);
        const squeue = 'gpu|R\ngpudev|R';

        const result = parsePartitionUsageOutput(sinfoNode, scontrol, squeue);
        const gpu = result.entries.find(e => e.partition === 'gpu')!;
        const gpudev = result.entries.find(e => e.partition === 'gpudev')!;

        assert.equal(gpu.allocatedGpus, 4, 'gpu partition should reflect node allocation');
        assert.equal(gpudev.allocatedGpus, 4, 'gpudev partition should also reflect same node allocation');
        assert.equal(gpu.idleGpus, 0);
        assert.equal(gpudev.idleGpus, 0);
        assert.equal(result.clusterAllocatedGpus, 4, 'cluster total should not double count allocated GPUs');
        assert.equal(result.clusterAvailableGpus, 4, 'cluster total should not double count available GPUs');
    });

    it('combines multiple sinfo rows for the same node/partition pair only once', () => {
        // sinfo -N may emit duplicate rows for the same node when a partition has
        // heterogeneous node groups. The deduplication guard should prevent double-counting.
        const sinfoNode = [
            'n01|gpu|allocated|gpu:h100:4',
            'n01|gpu|allocated|gpu:h100:4', // duplicate row — should be ignored
            'n02|gpu|idle|gpu:a100:2',
        ].join('\n');
        const scontrol = [
            scontrolBlock('n01', 3, 'h100'),
            scontrolBlock('n02', 0, 'a100'),
        ].join('\n');

        const { entries } = parsePartitionUsageOutput(sinfoNode, scontrol, 'gpu|R');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].totalNodes, 2);
        assert.equal(entries[0].totalGpus, 6); // 4 + 2, not 4+4+2
        assert.equal(entries[0].allocatedGpus, 3);
        assert.equal(entries[0].idleGpus, 3);
    });

    it('returns no partition usage for empty inputs', () => {
        assert.deepEqual(parsePartitionUsageOutput('', '', '').entries, []);
    });

    it('keeps CPU-only partitions apart and sums memory of schedulable nodes', () => {
        const sinfoNode = [
            'g01|gpu|idle|gpu:a100:4',
            'c01|cpu*|mixed|(null)',
            'c02|cpu*|idle|(null)',
            'c03|cpu*|drain|(null)',
        ].join('\n');
        const scontrol = [
            'NodeName=g01 RealMemory=512000 AllocMem=0',
            'NodeName=c01 RealMemory=1024 AllocMem=614',
            'NodeName=c02 RealMemory=1024 AllocMem=0',
            'NodeName=c03 RealMemory=1024 AllocMem=0',
        ].join('\n');
        const squeue = ['cpu|R', 'cpu|PD', 'cpu|PD'].join('\n');

        const { entries, cpuOnlyEntries } = parsePartitionUsageOutput(sinfoNode, scontrol, squeue);

        assert.deepEqual(entries.map(entry => entry.partition), ['gpu']);
        assert.equal(cpuOnlyEntries?.length, 1);
        const cpu = cpuOnlyEntries![0];
        assert.equal(cpu.partition, 'cpu');
        assert.deepEqual(
            [cpu.allocatedNodes, cpu.idleNodes, cpu.otherNodes, cpu.runningJobs, cpu.pendingJobs],
            [1, 1, 1, 1, 2],
        );
        // The drained node's memory can't be scheduled, so it is left out
        assert.equal(cpu.usableMemoryMb, 2048);
        assert.equal(cpu.allocatedMemoryMb, 614);
        assert.equal(formatPartitionUsageMemoryBreakdown(cpu), '0.6/2.0 GB allocated, 1.4 GB free');
    });
});

describe('getNodeIdleGpusByType', () => {
    it('takes typed allocations off their own type', () => {
        const idle = getNodeIdleGpusByType(
            [{ type: 'a100', count: 4 }, { type: 'v100', count: 2 }],
            [{ type: 'v100', count: 1 }],
        );
        assert.deepEqual([...idle], [['a100', 4], ['v100', 1]]);
    });

    it('takes an untyped allocation off the node\'s types in order', () => {
        assert.deepEqual([...getNodeIdleGpusByType([{ type: 'a100', count: 4 }], [{ type: 'generic', count: 3 }])], [['a100', 1]]);
        assert.deepEqual(
            [...getNodeIdleGpusByType([{ type: 'a100', count: 2 }, { type: 'v100', count: 2 }], [{ type: 'generic', count: 3 }])],
            [['a100', 0], ['v100', 1]],
        );
    });

    it('never reports negative idle GPUs', () => {
        assert.deepEqual([...getNodeIdleGpusByType([{ type: 'a100', count: 2 }], [{ type: 'a100', count: 5 }])], [['a100', 0]]);
    });
});
