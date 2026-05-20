import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmService } from '../slurmService';
import { SlurmExecutor, SlurmCommandInvocation, SlurmCommandResult } from '../slurmExecutor';

function makeMockExecutor(handler: (cmd: string, args: string[]) => SlurmCommandResult): SlurmExecutor {
    return {
        kind: 'local' as const,
        connectionKey: 'local',
        run(invocation: SlurmCommandInvocation): Promise<SlurmCommandResult> {
            return Promise.resolve(handler(invocation.command, invocation.args ?? []));
        },
    };
}

describe('SlurmService job loading', () => {
    it('uses the scontrol partition when it differs from the squeue summary partition', async () => {
        const executor = makeMockExecutor((command, args) => {
            if (command === 'id') {
                return { stdout: 'testuser\n', stderr: '' };
            }

            if (command === 'squeue') {
                return {
                    stdout: '26978670|EgoVLPv2_Pretraining_Baseline|R|3:05|gpu|ravg[1007,1076,1082-1083]|1-00:00:00|N/A|None\n',
                    stderr: '',
                };
            }

            if (command === 'scontrol' && args.join(' ') === 'show job 26978670') {
                return {
                    stdout: [
                        'JobId=26978670 JobName=EgoVLPv2_Pretraining_Baseline',
                        'Partition=mpib_gpu',
                        'StdOut=/tmp/dduka/logs/egovlp2_26978670.out',
                        'StdErr=/tmp/dduka/logs/egovlp2_26978670.err',
                        'Command=/u/dduka/work/projects/train.sbatch',
                        'WorkDir=/u/dduka/work/projects',
                        'NumNodes=4',
                        'TresPerNode=gres/gpu:a100:4',
                    ].join(' '),
                    stderr: '',
                };
            }

            throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
        });

        const service = new SlurmService(undefined, undefined, executor);
        const jobs = await service.getJobs();

        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].partition, 'mpib_gpu');
        assert.equal(jobs[0].gpuCount, 16);
    });

    it('keeps the squeue partition when scontrol does not report one', async () => {
        const executor = makeMockExecutor((command, args) => {
            if (command === 'id') {
                return { stdout: 'testuser\n', stderr: '' };
            }

            if (command === 'squeue') {
                return {
                    stdout: '26978671|train|R|3:05|gpu|node01|1-00:00:00|N/A|None\n',
                    stderr: '',
                };
            }

            if (command === 'scontrol' && args.join(' ') === 'show job 26978671') {
                return {
                    stdout: [
                        'JobId=26978671 JobName=train',
                        'StdOut=/tmp/job.out',
                        'StdErr=/tmp/job.err',
                        'Command=/work/train.sbatch',
                        'WorkDir=/work',
                    ].join(' '),
                    stderr: '',
                };
            }

            throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
        });

        const service = new SlurmService(undefined, undefined, executor);
        const jobs = await service.getJobs();

        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].partition, 'gpu');
    });
});
