import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmCommandRunner, SlurmService, isJobHeld } from '../slurmService';

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

    it('can submit a mock job with a dependency', async () => {
        const service = createMockService();

        const result = await service.submitJob('/tmp/local-test.sbatch', undefined, 'afterok:91001');
        const jobs = await service.getJobs();

        assert.equal(result.success, true);
        assert.ok(result.jobId);
        assert.ok(jobs.some(job =>
            job.jobId === result.jobId &&
            job.name === 'local-test.sbatch' &&
            job.state === 'PD' &&
            job.pendingReason === 'Dependency' &&
            job.dependency === 'afterok:91001'
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

    it('can get and update array task throttle in mock mode', async () => {
        const service = createMockService();

        // The mock job array is 91004_[3-10%2]
        const initialThrottle = await service.getArrayThrottle('91004');
        assert.equal(initialThrottle, 2);

        // Update throttle
        const updateResult = await service.updateArrayThrottle('91004', 5);
        assert.deepEqual(updateResult, {
            success: true,
            message: 'Array task throttle for job 91004 updated to 5 successfully (Mock)'
        });

        // Fetch again, should be 5
        const newThrottle = await service.getArrayThrottle('91004');
        assert.equal(newThrottle, 5);
    });

    it('can hold and release pending jobs in mock mode', async () => {
        const service = createMockService();

        // Check helper first
        assert.equal(isJobHeld('JobHeldUser'), true);
        assert.equal(isJobHeld('JobHeldAdmin'), true);
        assert.equal(isJobHeld('JobHoldMaxRequeue'), true);
        assert.equal(isJobHeld('Resources'), false);

        // Fetch mock job 91002 (pending sweep, not held initially)
        let jobs = await service.getJobs();
        let sweepJob = jobs.find(j => j.jobId === '91002');
        assert.ok(sweepJob);
        assert.equal(sweepJob.pendingReason, 'Resources');
        assert.equal(isJobHeld(sweepJob.pendingReason), false);

        // Hold job
        const holdResult = await service.holdJob('91002');
        assert.deepEqual(holdResult, {
            success: true,
            message: 'Job 91002 held successfully (Mock)'
        });

        jobs = await service.getJobs();
        sweepJob = jobs.find(j => j.jobId === '91002');
        assert.ok(sweepJob);
        assert.equal(sweepJob.pendingReason, 'JobHeldUser');
        assert.equal(isJobHeld(sweepJob.pendingReason), true);

        // Release job
        const releaseResult = await service.releaseJob('91002');
        assert.deepEqual(releaseResult, {
            success: true,
            message: 'Job 91002 released successfully (Mock)'
        });

        jobs = await service.getJobs();
        sweepJob = jobs.find(j => j.jobId === '91002');
        assert.ok(sweepJob);
        assert.equal(sweepJob.pendingReason, 'Priority');
        assert.equal(isJobHeld(sweepJob.pendingReason), false);
    });

    it('can bulk hold and release pending jobs in mock mode', async () => {
        const service = createMockService();

        // Initially we have four pending jobs in mock mode
        let jobs = await service.getJobs();
        let pending = jobs.filter(j => j.state === 'PD');
        assert.equal(pending.length, 4);
        assert.equal(pending.every(j => !isJobHeld(j.pendingReason)), true);

        // Bulk hold
        const holdAllResult = await service.holdAllPendingJobs();
        assert.equal(holdAllResult.success, true);
        assert.equal(holdAllResult.message.includes('Successfully held all pending jobs'), true);

        jobs = await service.getJobs();
        pending = jobs.filter(j => j.state === 'PD');
        assert.equal(pending.length, 4);
        assert.equal(pending.every(j => isJobHeld(j.pendingReason)), true);

        // Bulk release
        const releaseAllResult = await service.releaseAllPendingJobs();
        assert.equal(releaseAllResult.success, true);
        assert.equal(releaseAllResult.message.includes('Successfully released all held jobs'), true);

        jobs = await service.getJobs();
        pending = jobs.filter(j => j.state === 'PD');
        assert.equal(pending.length, 4);
        assert.equal(pending.every(j => !isJobHeld(j.pendingReason)), true);
    });

    it('can cancel all running jobs in mock mode', async () => {
        const service = createMockService();

        // Check initial running jobs count (only 1 running job: 91001)
        let jobs = await service.getJobs();
        let running = jobs.filter(j => j.state === 'R');
        assert.equal(running.length, 1);

        // Cancel all running
        const cancelResult = await service.cancelAllRunningJobs();
        assert.deepEqual(cancelResult, {
            success: true,
            message: 'All running jobs cancelled successfully (Mock)'
        });

        // Verify running jobs are removed
        jobs = await service.getJobs();
        running = jobs.filter(j => j.state === 'R');
        assert.equal(running.length, 0);

        // Verify pending jobs are still intact
        let pending = jobs.filter(j => j.state === 'PD');
        assert.equal(pending.length, 4);
    });
});

