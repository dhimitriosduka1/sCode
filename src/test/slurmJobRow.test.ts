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

    // Near the wall clock the proportion is already in the bar; the number the
    // user acts on is how long is left to checkpoint or requeue.
    it('trades the percentage for remaining time near the time limit', () => {
        assert.deepEqual(getSlurmJobRowParts(job({ time: '00:57:00' })), {
            label: 'train-transformer  91001',
            description: '●●●●●●●● 3m left',
        });
    });

    it('switches over exactly at the warning threshold', () => {
        assert.equal(getSlurmJobRowParts(job({ time: '00:54:00' })).description, '●●●●●●●○ 6m left');
        assert.equal(getSlurmJobRowParts(job({ time: '00:53:00' })).description, '●●●●●●●○ 88%');
    });

    it('reports a job already past its limit as out of time', () => {
        assert.equal(getSlurmJobRowParts(job({ time: '01:00:30' })).description, '●●●●●●●● 0s left');
    });

    // Half a day is not "finishing", so a long job keeps the percentage until it
    // is genuinely within the warning window.
    it('keeps the percentage on a long job with hours still to run', () => {
        assert.equal(
            getSlurmJobRowParts(job({ time: '6-12:00:00', timeLimit: '7-00:00:00' })).description,
            '●●●●●●●○ 93%'
        );
    });

    it('switches to remaining time once a long job is close', () => {
        assert.equal(
            getSlurmJobRowParts(job({ time: '6-22:30:00', timeLimit: '7-00:00:00' })).description,
            '●●●●●●●● 1h 30m left'
        );
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
