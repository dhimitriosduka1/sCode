import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    parseClusterAccountOverviewOutput,
    parseClusterLeaderboardOutput,
    parsePartitionUsageOutput,
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
});

describe('parsePartitionUsageOutput', () => {
    it('aggregates GPU partition capacity and queue pressure', () => {
        const entries = parsePartitionUsageOutput([
            'gpu*|5|2/2/1/5|gpu:a100:4',
            'h200|4|1/3/0/4|gpu:h200:4',
            'cpu|8|1/7/0/8|(null)',
        ].join('\n'), [
            'gpu|R|gpu:a100:2',
            'gpu|PD|gpu:a100:4',
            'h200|R|gres/gpu:h200=1',
            'cpu|R|(null)',
            'cpu|PD|(null)',
        ].join('\n'));

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
    });

    it('filters out CPU-only partitions', () => {
        assert.deepEqual(parsePartitionUsageOutput(
            'cpu|8|1/7/0/8|(null)',
            'cpu|R|(null)\ncpu|PD|(null)',
        ), []);
    });

    it('counts pending jobs across comma-separated GPU partition choices', () => {
        const entries = parsePartitionUsageOutput([
            'gpu|2|0/2/0/2|gpu:a100:4',
            'h200|2|0/2/0/2|gpu:h200:4',
        ].join('\n'), 'gpu,h200|PD|gpu:a100:1');

        assert.deepEqual(entries.map(entry => ({
            partition: entry.partition,
            pendingJobs: entry.pendingJobs,
            runningJobs: entry.runningJobs,
        })), [
            { partition: 'gpu', pendingJobs: 1, runningJobs: 0 },
            { partition: 'h200', pendingJobs: 1, runningJobs: 0 },
        ]);
    });

    it('combines multiple sinfo rows for the same partition', () => {
        const entries = parsePartitionUsageOutput([
            'gpu|2|1/1/0/2|gpu:h100:4(S:0)',
            'gpu|1|0/1/0/1|gpu:a100:2',
        ].join('\n'), 'gpu|R|gpu:h100:3');

        assert.deepEqual(entries, [{
            partition: 'gpu',
            isDefault: false,
            totalNodes: 3,
            allocatedNodes: 1,
            idleNodes: 2,
            otherNodes: 0,
            totalGpus: 10,
            availableGpus: 10,
            allocatedGpus: 3,
            idleGpus: 7,
            runningJobs: 1,
            pendingJobs: 0,
            gpuTypes: [
                { type: 'h100', count: 8 },
                { type: 'a100', count: 2 },
            ],
        }]);
    });

    it('returns no partition usage for empty sinfo and squeue output', () => {
        assert.deepEqual(parsePartitionUsageOutput('', ''), []);
    });
});
