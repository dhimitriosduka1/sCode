import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmJob } from '../slurmService';
import { getSlurmJobRowParts } from '../slurmJobRow';

function job(overrides: Partial<SlurmJob>): SlurmJob {
    return {
        jobId: '91001',
        name: 'train-transformer',
        state: 'R',
        time: '00:21:00',
        partition: 'gpu',
        nodes: 'node-a',
        stdoutPath: '/tmp/slurm-91001.out',
        stderrPath: '/tmp/slurm-91001.err',
        timeLimit: '01:00:00',
        startTime: 'N/A',
        workDir: '/tmp',
        submitScript: '/tmp/job.slurm',
        ...overrides,
    };
}

describe('Slurm job row formatting', () => {
    it('puts running job progress in the trailing description', () => {
        assert.deepEqual(getSlurmJobRowParts(job({})), {
            label: 'train-transformer  91001',
            description: '●●●○○○○○ 35%',
        });
    });

    it('keeps elapsed time in the description when running progress is unavailable', () => {
        assert.deepEqual(getSlurmJobRowParts(job({ timeLimit: 'UNLIMITED' })), {
            label: 'train-transformer',
            description: '91001 • 00:21:00',
        });
    });

    it('preserves pending job detail formatting', () => {
        assert.deepEqual(getSlurmJobRowParts(job({
            state: 'PD',
            pendingReason: 'Priority',
            dependency: 'afterok:90000',
        })), {
            label: 'train-transformer',
            description: '91001 • Waiting on priority • Starts: ~TBD • 🔗',
        });
    });
});
