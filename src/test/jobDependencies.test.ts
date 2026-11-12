import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmJob } from '../slurmService';
import { describeStrandedJobs, parseDependency, QueueDependencies, readCancelTarget } from '../jobDependencies';

function job(jobId: string, name: string, overrides: Partial<SlurmJob> = {}): SlurmJob {
    const pending = overrides.dependency !== undefined || overrides.pendingReason !== undefined;
    return {
        jobId,
        name,
        state: pending ? 'PD' : 'R',
        time: '0:00',
        partition: 'gpu',
        nodes: 'N/A',
        stdoutPath: 'N/A',
        stderrPath: 'N/A',
        timeLimit: '01:00:00',
        startTime: 'N/A',
        workDir: '/tmp',
        submitScript: '/tmp/job.sbatch',
        ...(pending ? { pendingReason: 'Dependency' } : {}),
        ...overrides,
    };
}

const ids = (jobs: SlurmJob[]) => jobs.map((each) => each.jobId);

describe('parseDependency', () => {
    it('reads squeue output, one job per condition with its state', () => {
        assert.deepEqual(parseDependency('afterok:123(unfulfilled),afterany:456_*(failed)'), {
            anyOf: false,
            conditions: [
                { type: 'afterok', jobId: '123', failed: false },
                { type: 'afterany', jobId: '456_*', failed: true },
            ],
        });
    });

    it('reads a dependency as typed, several jobs to one condition', () => {
        assert.deepEqual(parseDependency('afterok:1:2'), {
            anyOf: false,
            conditions: [
                { type: 'afterok', jobId: '1', failed: false },
                { type: 'afterok', jobId: '2', failed: false },
            ],
        });
    });

    it('reads `?` as any one being enough', () => {
        assert.equal(parseDependency('afterok:1(unfulfilled)?afterok:2(unfulfilled)')?.anyOf, true);
    });

    it('keeps the job of an after+delay condition and array tasks', () => {
        assert.deepEqual(parseDependency('after:5+10(unfulfilled),afterok:123_4(unfulfilled)')?.conditions, [
            { type: 'after', jobId: '5', failed: false },
            { type: 'afterok', jobId: '123_4', failed: false },
        ]);
    });

    it('reads singleton, which names no job', () => {
        assert.deepEqual(parseDependency('singleton(unfulfilled)')?.conditions, [{ type: 'singleton', failed: false }]);
    });

    it('has nothing to wait for when Slurm reports none', () => {
        for (const value of [undefined, '', '(null)', 'None', 'N/A']) {
            assert.equal(parseDependency(value), undefined, String(value));
        }
    });
});

describe('readCancelTarget', () => {
    it('tells a whole job or array from part of an array', () => {
        assert.deepEqual(readCancelTarget('1002'), { base: '1002', whole: true });
        assert.deepEqual(readCancelTarget('200_2'), { base: '200', whole: false, tasks: '2' });
        assert.deepEqual(readCancelTarget('200_[1-3]'), { base: '200', whole: false, tasks: '1-3' });
        assert.deepEqual(readCancelTarget('91004_[3-10%2]'), { base: '91004', whole: false, tasks: '3-10%2' });
    });
});

describe('QueueDependencies.describe', () => {
    const trainA = job('1002', 'train-a');
    const trainB = job('1003', 'train-b');

    it('names the queued jobs a pending job waits for, with their IDs', () => {
        const evalJob = job('1005', 'eval', { dependency: 'afterok:1002(unfulfilled),afterok:1003(unfulfilled)' });
        assert.deepEqual(new QueueDependencies([trainA, trainB, evalJob]).describe(evalJob), {
            kind: 'waiting',
            jobs: ['train-a (1002)', 'train-b (1003)'],
            anyOf: false,
        });
    });

    it('tells apart queued jobs that share a name', () => {
        const evalJob = job('1005', 'eval', { dependency: 'afterok:1002(unfulfilled),afterok:1003(unfulfilled)' });
        const queue = new QueueDependencies([job('1002', 'train'), job('1003', 'train'), evalJob]);
        assert.deepEqual(queue.describe(evalJob), { kind: 'waiting', jobs: ['train (1002)', 'train (1003)'], anyOf: false });
    });

    it('gives an array by its base ID, and one task by its own', () => {
        const aggregate = job('301', 'aggregate', { dependency: 'afterok:200_*(unfulfilled),afterok:200_2(unfulfilled)' });
        const queue = new QueueDependencies([job('200_1', 'sweep'), job('200_2', 'sweep'), aggregate]);
        assert.deepEqual(queue.describe(aggregate), { kind: 'waiting', jobs: ['sweep (200)', 'sweep (200_2)'], anyOf: false });
    });

    it('gives the ID of a job not in the queue', () => {
        const evalJob = job('1005', 'eval', { dependency: 'afterok:998(unfulfilled)' });
        assert.deepEqual(new QueueDependencies([evalJob]).describe(evalJob), { kind: 'waiting', jobs: ['998'], anyOf: false });
    });

    it('names the earlier jobs a singleton waits for', () => {
        const first = job('1010', 'finetune');
        const second = job('1011', 'finetune', { dependency: 'singleton(unfulfilled)' });
        assert.deepEqual(new QueueDependencies([first, second]).describe(second), { kind: 'waiting', jobs: ['finetune (1010)'], anyOf: false });
    });

    it('leaves out a failed alternative while another can still be met', () => {
        const evalJob = job('1005', 'eval', { dependency: 'afterok:998(failed)?afterok:1002(unfulfilled)' });
        assert.deepEqual(new QueueDependencies([trainA, evalJob]).describe(evalJob), {
            kind: 'waiting',
            jobs: ['train-a (1002)'],
            anyOf: true,
        });
    });

    it('says a job whose dependency failed never runs, and which job failed', () => {
        const plot = job('1007', 'plot', { dependency: 'afterok:998(failed)', pendingReason: 'DependencyNeverSatisfied' });
        assert.deepEqual(new QueueDependencies([plot]).describe(plot), { kind: 'never', failed: ['998'], succeeded: [], waitsOn: [] });
    });

    // Slurm fails afternotok when the job it waits on succeeds
    it('says which job succeeded when an afternotok job never runs', () => {
        const fallback = job('1005', 'fallback', { dependency: 'afternotok:998(failed)', pendingReason: 'DependencyNeverSatisfied' });
        assert.deepEqual(new QueueDependencies([fallback]).describe(fallback), { kind: 'never', failed: [], succeeded: ['998'], waitsOn: [] });
    });

    it('carries "never runs" down the chain, whatever the condition type', () => {
        const plot = job('1007', 'plot', { dependency: 'afterok:998(failed)', pendingReason: 'DependencyNeverSatisfied' });
        // Slurm still says Dependency for these: they wait on a job that never ends
        const publish = job('1008', 'publish', { dependency: 'afterok:1007(unfulfilled)' });
        const cleanup = job('1009', 'cleanup', { dependency: 'afterany:1008(unfulfilled)' });
        const queue = new QueueDependencies([plot, publish, cleanup]);
        assert.deepEqual(queue.describe(publish), { kind: 'never', failed: [], succeeded: [], waitsOn: ['plot (1007)'] });
        assert.deepEqual(queue.describe(cleanup), { kind: 'never', failed: [], succeeded: [], waitsOn: ['publish (1008)'] });
    });

    it('takes Slurm\'s word that a dependency can never be met', () => {
        const stuck = job('1007', 'stuck', { pendingReason: 'DependencyNeverSatisfied' });
        assert.deepEqual(new QueueDependencies([stuck]).describe(stuck), { kind: 'never', failed: [], succeeded: [], waitsOn: [] });
    });

    it('has nothing to say about running jobs or jobs without a dependency', () => {
        const queued = job('1005', 'eval', { pendingReason: 'Priority' });
        const queue = new QueueDependencies([trainA, queued]);
        assert.equal(queue.describe(trainA), undefined);
        assert.equal(queue.describe(queued), undefined);
    });
});

describe('QueueDependencies.strandedByCancel', () => {
    const trainA = job('1002', 'train-a');

    it('finds jobs that need the cancelled job to succeed, and jobs that need those', () => {
        const queue = new QueueDependencies([
            trainA,
            job('1005', 'eval', { dependency: 'afterok:1002(unfulfilled)' }),
            job('1006', 'report', { dependency: 'afterok:1005(unfulfilled)' }),
        ]);
        assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('1002'))), ['1005', '1006']);
    });

    // A cancel ends the job, which is all these wait for (afternotok counts
    // a cancel as a failure), so they still run
    it('leaves jobs that only wait for the cancelled job to end or start', () => {
        const queue = new QueueDependencies([
            trainA,
            job('1005', 'any', { dependency: 'afterany:1002(unfulfilled)' }),
            job('1006', 'on-failure', { dependency: 'afternotok:1002(unfulfilled)' }),
            job('1007', 'on-start', { dependency: 'after:1002(unfulfilled)' }),
        ]);
        assert.deepEqual(queue.strandedByCancel(readCancelTarget('1002')), []);
    });

    // Cancelling eval along with train-a ends it, which is all cleanup waits for
    it('leaves a job that only waits for a stranded job to end, since that one is cancelled too', () => {
        const queue = new QueueDependencies([
            trainA,
            job('1005', 'eval', { dependency: 'afterok:1002(unfulfilled)' }),
            job('1006', 'cleanup', { dependency: 'afterany:1005(unfulfilled)' }),
        ]);
        assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('1002'))), ['1005']);
    });

    it('leaves a job with another way to run', () => {
        const queue = new QueueDependencies([
            trainA,
            job('1003', 'train-b'),
            job('1005', 'eval', { dependency: 'afterok:1002(unfulfilled)?afterok:1003(unfulfilled)' }),
        ]);
        assert.deepEqual(queue.strandedByCancel(readCancelTarget('1002')), []);
        assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('1003'))), []);
    });

    it('counts an alternative that already failed as no way to run', () => {
        const queue = new QueueDependencies([
            trainA,
            job('1005', 'eval', { dependency: 'afterok:998(failed)?afterok:1002(unfulfilled)' }),
        ]);
        assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('1002'))), ['1005']);
    });

    it('leaves out jobs stranded for reasons of their own', () => {
        const queue = new QueueDependencies([
            trainA,
            job('1007', 'plot', { dependency: 'afterok:998(failed)', pendingReason: 'DependencyNeverSatisfied' }),
        ]);
        assert.deepEqual(queue.strandedByCancel(readCancelTarget('1002')), []);
    });

    it('offers the dependents of a job that already never runs', () => {
        const queue = new QueueDependencies([
            job('1007', 'plot', { dependency: 'afterok:998(failed)', pendingReason: 'DependencyNeverSatisfied' }),
            job('1008', 'publish', { dependency: 'afterok:1007(unfulfilled)' }),
        ]);
        assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('1007'))), ['1008']);
    });

    describe('arrays', () => {
        const queue = new QueueDependencies([
            job('200_1', 'sweep'),
            job('200_2', 'sweep'),
            job('200_[3-9]', 'sweep', { pendingReason: 'Priority' }),
            job('301', 'aggregate', { dependency: 'afterok:200_*(unfulfilled)' }),
            job('302', 'paired', { dependency: 'aftercorr:200(unfulfilled)' }),
            job('303', 'task-two', { dependency: 'afterok:200_2(unfulfilled)' }),
            job('304', 'task-five', { dependency: 'afterok:200_5(unfulfilled)' }),
        ]);

        // aftercorr pairs task with task: a dependent task whose partner already
        // succeeded still runs, and the queue no longer shows which did
        it('strands what needs the array when all of it is cancelled, but not an aftercorr dependent', () => {
            assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('200'))), ['301', '303', '304']);
        });

        it('strands what needs the whole array or the cancelled task when one task is cancelled', () => {
            assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('200_2'))), ['301', '303']);
        });

        // A task still inside the array's pending row (200_[3-9]) has no job
        // record of its own, so Slurm drops a dependency on it when it is
        // cancelled, rather than failing it: 304 runs
        it('leaves a job waiting on a task cancelled from inside the pending row', () => {
            assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('200_5'))), ['301']);
        });

        it('strands what needs the whole array or a task of the cancelled range with a row of its own', () => {
            assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('200_[1-3]'))), ['301', '303']);
            assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('200_[1,3]'))), ['301']);
            assert.deepEqual(ids(queue.strandedByCancel(readCancelTarget('200_[4-6]'))), ['301']);
        });

        it('strands only what needs the whole array when its pending tasks are cancelled', () => {
            // 200_2 is running, so the cancel leaves it to finish for 303
            assert.deepEqual(ids(queue.strandedByCancel({ base: '200', whole: false })), ['301']);
        });

        // A pending task can get a row of its own (`400_1`), split off from the
        // pending row, e.g. by a hold; cancelling it fails what waits on it
        it('strands what needs a pending task with a row of its own', () => {
            const split = new QueueDependencies([
                job('400_[3-10%2]', 'sweep', { pendingReason: 'JobArrayTaskLimit' }),
                job('400_1', 'sweep', { pendingReason: 'JobHeldUser' }),
                job('501', 'task-nine', { dependency: 'afterok:400_9(unfulfilled)' }),
                job('502', 'task-one', { dependency: 'afterok:400_1(unfulfilled)' }),
            ]);
            assert.deepEqual(ids(split.strandedByCancel({ base: '400', whole: false })), ['502']);
            assert.deepEqual(ids(split.strandedByCancel(readCancelTarget('400_[1-9]'))), ['502']);
            assert.deepEqual(ids(split.strandedByCancel(readCancelTarget('400'))), ['501', '502']);
        });
    });
});

describe('describeStrandedJobs', () => {
    // Names the cancelled job: "it" read as the pending job itself
    it('puts one stranded job in a sentence naming the cancelled job', () => {
        assert.equal(
            describeStrandedJobs('dependent-eval', [job('91009', 'eval-report')]),
            '"eval-report" (91009) would never run without "dependent-eval" finishing successfully.',
        );
    });

    it('lists several stranded jobs', () => {
        assert.equal(
            describeStrandedJobs('train-transformer', [job('91003', 'dependent-eval'), job('91009', 'eval-report')]),
            'These 2 pending jobs would never run without "train-transformer" finishing successfully:\n\n'
                + '• dependent-eval (91003)\n• eval-report (91009)',
        );
    });

    it('counts the jobs past the first ten', () => {
        const stranded = Array.from({ length: 12 }, (_, index) => job(String(2000 + index), `step-${index}`));
        const lines = describeStrandedJobs('prep', stranded).split('\n');
        assert.equal(lines[0], 'These 12 pending jobs would never run without "prep" finishing successfully:');
        assert.equal(lines.length, 2 + 10 + 1);
        assert.equal(lines[lines.length - 1], '…and 2 more');
    });
});
