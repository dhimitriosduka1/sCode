import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatGpuTypeBreakdown, summarizeRunningGpus } from '../userGpuUsage';

describe('summarizeRunningGpus', () => {
    it('adds up the GPUs of running jobs, by type, most first', () => {
        const usage = summarizeRunningGpus([
            { state: 'R', gpuCount: 2, gpuType: 'H200' },
            { state: 'R', gpuCount: 4, gpuType: 'A100' },
            { state: 'CF', gpuCount: 2, gpuType: 'H200' },
        ]);

        assert.deepEqual(usage, {
            gpuCount: 8,
            jobCount: 3,
            types: [
                { type: 'A100', gpuCount: 4, jobCount: 1 },
                { type: 'H200', gpuCount: 4, jobCount: 2 },
            ],
        });
        assert.equal(formatGpuTypeBreakdown(usage!), '4× A100, 4× H200');
    });

    it('leaves out pending and finishing jobs and jobs without GPUs', () => {
        const usage = summarizeRunningGpus([
            { state: 'PD', gpuCount: 8, gpuType: 'H200' },
            { state: 'CG', gpuCount: 8, gpuType: 'H200' },
            { state: 'R', gpuCount: 0 },
            { state: 'R' },
            { state: 'R', gpuCount: 1, gpuType: 'A100' },
        ]);

        assert.deepEqual(usage, {
            gpuCount: 1,
            jobCount: 1,
            types: [{ type: 'A100', gpuCount: 1, jobCount: 1 }],
        });
    });

    it('is undefined when no running job holds a GPU', () => {
        assert.equal(summarizeRunningGpus([{ state: 'R', gpuCount: 0 }, { state: 'PD', gpuCount: 4 }]), undefined);
        assert.equal(summarizeRunningGpus([]), undefined);
    });

    it('calls GPUs of no known type plain GPUs', () => {
        const usage = summarizeRunningGpus([{ state: 'R', gpuCount: 2 }]);

        assert.equal(formatGpuTypeBreakdown(usage!), '2× GPU');
    });
});
