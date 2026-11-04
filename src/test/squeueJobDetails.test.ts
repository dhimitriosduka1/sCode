import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseJobDetailsOutput, parseSqueueJobDetails, SlurmService, SQUEUE_JOB_DETAILS_COMMAND } from '../slurmService';

// As squeue prints SQUEUE_JOB_DETAILS_COMMAND on slurm-submit (Slurm 26.05)
const ROWS = [
    '52894729_[7-12%3]|/home/ada/jobs/%x-%A_%a.out|/home/ada/jobs/%x-%A_%a.err|/home/ada/jobs/test-job.sh|/home/ada/jobs|1|cpu=1,mem=200M,node=1,billing=1|N/A|N/A|(null)|',
    '52894729_4|/home/ada/jobs/%x-%A_%a.out|/home/ada/jobs/%x-%A_%a.err|/home/ada/jobs/test-job.sh|/home/ada/jobs|1|cpu=1,mem=200M,node=1,billing=1|N/A|N/A|(null)|',
    '52891442|/home/ada/l40/train.out|/home/ada/l40/train.err|/home/ada/l40/run job.sbatch|/home/ada/l40|2|cpu=16,mem=64G,node=2,billing=16,gres/gpu=6,gres/gpu:l40=6|gres/gpu:l40:3|N/A|afterok:52891441(unfulfilled)|',
].join('\n');

describe('job details from one squeue request', () => {
    it('reads each job as scontrol show job would describe it', () => {
        const details = parseSqueueJobDetails(`${ROWS}\n`);

        assert.deepEqual([...details.keys()], ['52894729_[7-12%3]', '52894729_4', '52891442']);
        assert.deepEqual(details.get('52894729_4'), {
            stdoutPath: '/home/ada/jobs/%x-%A_%a.out',
            stderrPath: '/home/ada/jobs/%x-%A_%a.err',
            submitScript: '/home/ada/jobs/test-job.sh',
            workDir: '/home/ada/jobs',
            gpuCount: undefined,
            gpuType: undefined,
            memory: '200M',
            dependency: undefined,
        });
        // The same answer scontrol's own record gives
        assert.deepEqual(details.get('52891442'), parseJobDetailsOutput(
            'JobId=52891442 NumNodes=2 AllocTRES=cpu=16,mem=64G,node=2,billing=16,gres/gpu=6,gres/gpu:l40=6 TresPerNode=gres/gpu:l40:3 '
            + 'Dependency=afterok:52891441(unfulfilled)\n   Command=/home/ada/l40/run job.sbatch\n   WorkDir=/home/ada/l40\n'
            + '   StdErr=/home/ada/l40/train.err\n   StdOut=/home/ada/l40/train.out',
        ));
        assert.equal(details.get('52891442')?.gpuCount, 6);
        assert.equal(details.get('52891442')?.gpuType, 'L40');
    });

    it('skips lines that are not rows of it, such as the other squeue format', () => {
        assert.equal(parseSqueueJobDetails('52894729|scode-cpu|R|1:51|cpu|cpu20-05|20:00|2026-11-04T19:27:50|None|schiele\n').size, 0);
        assert.equal(parseSqueueJobDetails('').size, 0);
    });

    it('fetches every job\'s details in one request, and scontrol only for jobs it lacks', async () => {
        const commands: string[] = [];
        const service = new SlurmService(undefined, undefined, async (command) => {
            commands.push(command);
            if (command === SQUEUE_JOB_DETAILS_COMMAND) {
                return { stdout: `${ROWS.split('\n')[1]}\n`, stderr: '' };
            }
            if (command.startsWith('squeue -u $USER --noheader --format=')) {
                return { stdout: '52894729_4|scode-array-b|R|0:30|cpu|cpu20-05|20:00|2026-11-04T19:27:50|None|schiele\n52894730|scode-cpu|R|0:10|cpu|cpu20-05|20:00|2026-11-04T19:28:10|None|schiele\n', stderr: '' };
            }
            if (command === 'scontrol show job 52894730') {
                return { stdout: 'JobId=52894730 StdOut=/home/ada/jobs/%x-%j.out StdErr=/home/ada/jobs/%x-%j.err Command=/home/ada/jobs/test-job.sh WorkDir=/home/ada/jobs', stderr: '' };
            }
            throw new Error(`not on this cluster: ${command}`);
        }, () => false, () => ({ username: 'ada', homeDir: '/home/ada', cluster: 'raven' }));

        const jobs = await service.getJobs();

        assert.deepEqual(jobs.map((job) => job.stdoutPath), [
            '/home/ada/jobs/scode-array-b-52894729_4.out',
            '/home/ada/jobs/scode-cpu-52894730.out',
        ]);
        assert.deepEqual(commands.filter((command) => command.startsWith('scontrol')), ['scontrol show job 52894730']);
    });

    it('asks nothing more when there are no jobs', async () => {
        const commands: string[] = [];
        const service = new SlurmService(undefined, undefined, async (command) => {
            commands.push(command);
            return { stdout: '', stderr: '' };
        }, () => false, () => ({ username: 'ada', homeDir: '/home/ada' }));

        assert.deepEqual(await service.getJobs(), []);
        assert.equal(commands.length, 1);
    });

    it('falls back to scontrol per job where squeue cannot report details', async () => {
        const commands: string[] = [];
        const service = new SlurmService(undefined, undefined, async (command) => {
            commands.push(command);
            if (command === SQUEUE_JOB_DETAILS_COMMAND) {
                throw Object.assign(new Error('squeue: error: Invalid field specification'), { code: 1 });
            }
            if (command.startsWith('squeue -u $USER --noheader --format=')) {
                return { stdout: '7|train|R|0:10|gpu|node1|20:00|N/A|None|lab\n', stderr: '' };
            }
            if (command === 'scontrol show job 7') {
                return { stdout: 'JobId=7 StdOut=/home/ada/train.out StdErr=/home/ada/train.err Command=/home/ada/train.sh WorkDir=/home/ada', stderr: '' };
            }
            throw new Error(`not on this cluster: ${command}`);
        }, () => false, () => ({ username: 'ada', homeDir: '/home/ada' }));

        const [job] = await service.getJobs();

        assert.equal(job.stdoutPath, '/home/ada/train.out');
        assert.ok(commands.includes('scontrol show job 7'));
    });
});
