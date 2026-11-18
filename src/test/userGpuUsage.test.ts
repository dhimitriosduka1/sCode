import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatGpuTypeBreakdown, summarizeRunningGpus } from '../userGpuUsage';

describe('summarizeRunningGpus', () => {
    it('adds up the GPUs of running jobs, by type, most first', () => {
        const usage = summarizeRunningGpus([
            { jobId: '1', state: 'R', gpuCount: 2, gpuType: 'H200' },
            { jobId: '2', state: 'R', gpuCount: 4, gpuType: 'A100' },
            { jobId: '3', state: 'CF', gpuCount: 2, gpuType: 'H200' },
        ]);

        assert.deepEqual(usage, {
            gpuCount: 8,
            jobCount: 3,
            types: [
                { type: 'A100', gpuCount: 4, jobCount: 1 },
                { type: 'H200', gpuCount: 4, jobCount: 2 },
            ],
        });
        assert.equal(formatGpuTypeBreakdown(usage), '4× A100, 4× H200');
    });

    it('leaves out pending and finishing jobs and jobs without GPUs', () => {
        const usage = summarizeRunningGpus([
            { jobId: '4', state: 'PD', gpuCount: 8, gpuType: 'H200' },
            { jobId: '5', state: 'CG', gpuCount: 8, gpuType: 'H200' },
            { jobId: '6', state: 'R', gpuCount: 0 },
            { jobId: '7', state: 'R' },
            { jobId: '8', state: 'R', gpuCount: 1, gpuType: 'A100' },
        ]);

        assert.deepEqual(usage, {
            gpuCount: 1,
            jobCount: 1,
            types: [{ type: 'A100', gpuCount: 1, jobCount: 1 }],
        });
    });

    it('counts zero when no running job holds a GPU', () => {
        const none = { gpuCount: 0, jobCount: 0, types: [] };

        assert.deepEqual(summarizeRunningGpus([{ jobId: '9', state: 'R', gpuCount: 0 }, { jobId: '10', state: 'PD', gpuCount: 4 }]), none);
        assert.deepEqual(summarizeRunningGpus([]), none);
        assert.equal(formatGpuTypeBreakdown(none), '');
    });

    it('calls GPUs of no known type plain GPUs', () => {
        const usage = summarizeRunningGpus([{ jobId: '11', state: 'R', gpuCount: 2 }]);

        assert.equal(formatGpuTypeBreakdown(usage), '2× GPU');
    });
});
