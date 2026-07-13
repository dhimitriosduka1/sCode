import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    parseClusterAccountOverviewOutput,
    parseClusterHogsOutput,
    parseClusterLeaderboardOutput,
    parsePartitionUsageOutput,
    parseScontrolNodeOutput,
} from '../slurmService';

describe('parseClusterLeaderboardOutput', () => {
    it('tracks only GPU jobs and excludes CPU-only users', () => {
        const entries = parseClusterLeaderboardOutput([
            'alice|mswk_inst|gpu:2',
            'alice|cpu_inst|(null)',
            'alice|cpu_inst|N/A',
            'bob|mcs_inst|gpu:a100:4',
            'bob|mcs_inst|gpu:h200:1',
            'carol|cpu_inst|(null)',
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
            'mixed|z_inst|gpu:1',
            'mixed|a_inst|gpu:2',
            'mixed|a_inst|gpu:1',
            'mixed|a_inst|gpu:a100:4,gpu:h200:1',
            'mixed|cpu_inst|(null)',
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

    it('parses Slurm-style gpu type counts from gres paths', () => {
        assert.deepEqual(parseClusterLeaderboardOutput('user|account|gres/gpu:h100=2'), [
            {
                username: 'user',
                accounts: ['account'],
                gpuCount: 2,
                gpuJobCount: 1,
                gpuTypes: [{ type: 'h100', count: 2 }],
            },
        ]);
    });

    it('multiplies per-node GPU requests by allocated node count', () => {
        assert.deepEqual(parseClusterLeaderboardOutput([
            'dduka|mpi_gpu|4|gpu:a100:4',
            'dduka|mpi_gpu|4|gpu:a100:4',
            'dduka|mpi_gpu|4|gpu:a100:4',
        ].join('\n')), [
            {
                username: 'dduka',
                accounts: ['mpi_gpu'],
                gpuCount: 48,
                gpuJobCount: 3,
                gpuTypes: [{ type: 'a100', count: 48 }],
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
            'alice|vision_lab|gpu:a100:2',
            'alice|local_inst|gpu:h200:1',
            'bob|vision_lab|gpu:a100:4',
            'carol|cpu_inst|(null)',
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
        assert.deepEqual(parseClusterAccountOverviewOutput('alice|(null)|gpu:2'), [
            {
                account: 'unknown',
                gpuCount: 2,
                gpuJobCount: 1,
                gpuTypes: [{ type: 'generic', count: 2 }],
                users: [{ username: 'alice', gpuCount: 2, gpuJobCount: 1 }],
            },
        ]);
    });

    it('multiplies account GPU usage by allocated node count', () => {
        assert.deepEqual(parseClusterAccountOverviewOutput([
            'dduka|mpi_gpu|4|gpu:a100:4',
            'dduka|mpi_gpu|4|gpu:a100:4',
            'dduka|mpi_gpu|4|gpu:a100:4',
        ].join('\n')), [
            {
                account: 'mpi_gpu',
                gpuCount: 48,
                gpuJobCount: 3,
                gpuTypes: [{ type: 'a100', count: 48 }],
                users: [{ username: 'dduka', gpuCount: 48, gpuJobCount: 3 }],
            },
        ]);
    });
});

describe('parseClusterHogsOutput', () => {
    it('uses node counts when ranking top GPU hogs', () => {
        assert.deepEqual(parseClusterHogsOutput([
            'dduka|4|gpu:a100:4',
            'dduka|4|gpu:a100:4',
            'dduka|4|gpu:a100:4',
            'alice|1|gpu:h100:8',
        ].join('\n')), {
            topJobHog: { username: 'dduka', jobCount: 3 },
            topGpuHog: { username: 'dduka', gpuCount: 48 },
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
            },
        ]);
        
        assert.equal(clusterAllocatedGpus, 3);
        assert.equal(clusterAvailableGpus, 32);
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
});
