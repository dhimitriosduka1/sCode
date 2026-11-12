import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmJob } from '../slurmService';
import { getSlurmJobRowParts } from '../slurmJobRow';
import type { DependencyStatus } from '../jobDependencies';

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

describe('Slurm job row dependencies', () => {
    const pending = (overrides: Partial<SlurmJob> = {}) => job({
        jobId: '1005',
        name: 'eval',
        state: 'PD',
        pendingReason: 'Dependency',
        ...overrides,
    });
    const describeRow = (overrides: Partial<SlurmJob>, dependency: DependencyStatus) =>
        getSlurmJobRowParts(pending(overrides), dependency).description;

    // The jobs' names say more than "Waiting on dependency", and Slurm has no
    // start estimate for a job held back by another
    it('names the jobs a pending job waits for in place of the reason and start', () => {
        assert.equal(describeRow({}, { kind: 'waiting', jobs: ['train-a'], anyOf: false }), '1005 • after train-a');
        assert.equal(describeRow({}, { kind: 'waiting', jobs: ['train-a', 'train-b'], anyOf: false }), '1005 • after train-a + train-b');
        assert.equal(describeRow({}, { kind: 'waiting', jobs: ['train-a', 'train-b'], anyOf: true }), '1005 • after train-a or train-b');
    });

    it('counts three or more jobs rather than naming them', () => {
        assert.equal(describeRow({}, { kind: 'waiting', jobs: ['a', 'b', 'c'], anyOf: false }), '1005 • after 3 jobs');
        assert.equal(describeRow({}, { kind: 'waiting', jobs: ['a', 'b', 'c'], anyOf: true }), '1005 • after any of 3 jobs');
    });

    it('keeps a hold, which applies on top of the dependency', () => {
        assert.equal(
            describeRow({ pendingReason: 'JobHeldUser' }, { kind: 'waiting', jobs: ['train-a'], anyOf: false }),
            '1005 • Held by user • after train-a',
        );
    });

    it('says why a job never runs', () => {
        assert.equal(describeRow({}, { kind: 'never', failed: ['998'], succeeded: [], waitsOn: [] }), '1005 • never runs: 998 failed');
        assert.equal(describeRow({}, { kind: 'never', failed: [], succeeded: ['998'], waitsOn: [] }), '1005 • never runs: 998 succeeded');
        assert.equal(describeRow({}, { kind: 'never', failed: ['997'], succeeded: ['998'], waitsOn: [] }), '1005 • never runs: 997 failed, 998 succeeded');
        assert.equal(describeRow({}, { kind: 'never', failed: [], succeeded: [], waitsOn: ['plot'] }), '1005 • never runs: waits on plot');
        assert.equal(describeRow({}, { kind: 'never', failed: [], succeeded: [], waitsOn: [] }), '1005 • never runs: dependency failed');
    });
});
