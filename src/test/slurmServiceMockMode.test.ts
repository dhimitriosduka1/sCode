import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmCommandRunner, SlurmService } from '../slurmService';

function createMockService(): SlurmService {
    const commandRunner: SlurmCommandRunner = async (command) => {
        throw new Error(`Unexpected command in mock mode: ${command}`);
    };

    return new SlurmService(undefined, undefined, commandRunner, () => true);
}

describe('SlurmService mock mode', () => {
    it('reports Slurm as available without running shell commands', async () => {
        const service = createMockService();

        assert.equal(await service.isAvailable(), true);
    });

    it('returns representative active jobs with pending reasons', async () => {
        const service = createMockService();
        const jobs = await service.getJobs();

        assert.ok(jobs.length >= 5);
        assert.ok(jobs.some(job => job.state === 'R'));
        assert.ok(jobs.some(job => job.state === 'CG'));
        assert.ok(jobs.some(job => job.state === 'PD' && job.pendingReason === 'Resources'));
        assert.ok(jobs.some(job => job.state === 'PD' && job.dependency === 'afterok:91001'));
        assert.equal(jobs.some(job => job.stdoutPath.includes('/tmp/slurm-mock')), false);
    });

    it('updates only mock jobs when cancelling pending jobs', async () => {
        const service = createMockService();

        const result = await service.cancelAllPendingJobs();
        const jobs = await service.getJobs();

        assert.deepEqual(result, {
            success: true,
            message: 'All pending jobs cancelled successfully',
        });
        assert.equal(jobs.some(job => job.state === 'PD'), false);
        assert.equal(jobs.some(job => job.state === 'R'), true);
    });

    it('updates mock array jobs when cancelling by state', async () => {
        const service = createMockService();

        assert.deepEqual(await service.getJobArrayInfo('91004'), { minIndex: 3, maxIndex: 3 });

        const result = await service.cancelJobByState('91004', 'PENDING');
        const jobs = await service.getJobs();

        assert.deepEqual(result, {
            success: true,
            message: 'PENDING jobs in 91004 cancelled successfully',
        });
        assert.equal(jobs.some(job => job.jobId === '91004_3'), false);
        assert.equal(await service.getJobArrayInfo('91004'), null);
    });

    it('can submit a mock job without sbatch', async () => {
        const service = createMockService();

        const result = await service.submitJob('/tmp/local-test.sbatch');
        const jobs = await service.getJobs();

        assert.equal(result.success, true);
        assert.ok(result.jobId);
        assert.ok(jobs.some(job =>
            job.jobId === result.jobId &&
            job.name === 'local-test.sbatch' &&
            job.state === 'PD' &&
            job.pendingReason === 'Priority'
        ));
    });

    it('returns mock history and cluster summary data', async () => {
        const service = createMockService();

        const history = await service.getJobHistory();
        const paths = await service.getHistoryJobPaths('90990');
        const hogs = await service.getClusterHogs();
        const leaderboard = await service.getClusterLeaderboard();
        const accountOverview = await service.getClusterAccountOverview();
        const partitionUsage = await service.getPartitionUsage();
        const stats = await service.getPartitionStats('h200');

        assert.ok(history.length >= 4);
        assert.ok(history.some(job => job.state === 'COMPLETED'));
        assert.ok(history.some(job => job.state === 'FAILED'));
        assert.ok(history.some(job => job.state === 'TIMEOUT'));
        assert.ok(history.some(job => job.state === 'CANCELLED'));
        assert.deepEqual(paths, {
            stdoutPath: '/work/vision_lab/runs/finished-training/logs/90990.out',
            stderrPath: '/work/vision_lab/runs/finished-training/logs/90990.err',
        });
        assert.deepEqual(hogs, {
            topJobHog: { username: 'nova42', jobCount: 8 },
            topGpuHog: { username: 'nova42', gpuCount: 24 },
        });
        assert.ok(leaderboard.length >= 6);
        assert.deepEqual(leaderboard[0], {
            username: 'nova42',
            accounts: ['atlas_lab'],
            gpuCount: 24,
            gpuJobCount: 3,
            gpuTypes: [
                { type: 'a100', count: 16 },
                { type: 'h200', count: 8 },
            ],
        });
        assert.deepEqual(accountOverview.find(entry => entry.account === 'atlas_lab'), {
            account: 'atlas_lab',
            gpuCount: 24,
            gpuJobCount: 3,
            gpuTypes: [
                { type: 'a100', count: 16 },
                { type: 'h200', count: 8 },
            ],
            users: [
                { username: 'nova42', gpuCount: 24, gpuJobCount: 3 },
            ],
        });
        assert.ok(partitionUsage.some(entry =>
            entry.partition === 'h200' &&
            entry.totalGpus === 24 &&
            entry.availableGpus === 20 &&
            entry.allocatedGpus === 6 &&
            entry.idleGpus === 14
        ));
        assert.ok(partitionUsage.some(entry =>
            entry.partition === 'debug-gpu' &&
            entry.availableGpus === 2 &&
            entry.allocatedGpus === 0
        ));
        assert.deepEqual(stats, {
            totalGpus: 20,
            allocatedGpus: 6,
            idleGpus: 14,
            runningJobs: 2,
            pendingJobs: 2,
            nodesUp: 5,
            nodesTotal: 6,
            nodeStates: '5/6',
        });
    });
});
