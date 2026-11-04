import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ExecOptions } from 'child_process';
import { SlurmService } from '../slurmService';

/**
 * Every Slurm command has to go through the service's runner, since that is
 * where commands will be sent to a cluster over SSH. One that called
 * child_process directly would quietly run on this machine instead.
 */
describe('SlurmService command runner', () => {
    const calls: [string, (service: SlurmService) => Promise<unknown>][] = [
        ['getJobs', (service) => service.getJobs()],
        ['getJobDetails', (service) => service.getJobDetails('123')],
        ['isAvailable', (service) => service.isAvailable()],
        ['getClusterHogs', (service) => service.getClusterHogs()],
        ['getClusterLeaderboard', (service) => service.getClusterLeaderboard()],
        ['getClusterAccountOverview', (service) => service.getClusterAccountOverview()],
        ['getPartitionUsage', (service) => service.getPartitionUsage()],
        ['getCpuPartitionUsage', (service) => service.getCpuPartitionUsage()],
        ['getMaintenanceWindows', (service) => service.getMaintenanceWindows()],
        ['getJobArrayInfo', (service) => service.getJobArrayInfo('123')],
        ['submitJob', (service) => service.submitJob('/scratch/ada/train.sh')],
        ['getArrayThrottle', (service) => service.getArrayThrottle('123')],
        ['updateArrayThrottle', (service) => service.updateArrayThrottle('123', 4)],
        ['holdJob', (service) => service.holdJob('123')],
        ['releaseJob', (service) => service.releaseJob('123')],
        ['updateJobDependency', (service) => service.updateJobDependency('123', 'afterok:100')],
    ];

    for (const [name, call] of calls) {
        it(`runs ${name}'s commands through the runner`, async () => {
            const commands: string[] = [];
            const service = new SlurmService(undefined, undefined, async (command) => {
                commands.push(command);
                return { stdout: '', stderr: '' };
            });

            await call(service);

            assert.ok(commands.length > 0, `${name} ran no command through the runner`);
        });
    }

    it('passes sbatch the script\'s folder as its working directory', async () => {
        const runs: { command: string; options?: ExecOptions }[] = [];
        const service = new SlurmService(undefined, undefined, async (command, options) => {
            runs.push({ command, options });
            return { stdout: 'Submitted batch job 4242\n', stderr: '' };
        });

        const result = await service.submitJob('/scratch/ada/train.sh');

        assert.equal(result.jobId, '4242');
        assert.deepEqual(runs[0], { command: "sbatch '/scratch/ada/train.sh'", options: { cwd: '/scratch/ada' } });
    });
});

describe('SlurmService username', () => {
    it('expands %u in log paths to the user on the cluster commands run on', async () => {
        const service = new SlurmService(undefined, undefined, async (command) => ({
            stdout: command.startsWith('scontrol')
                ? 'JobId=123 JobName=train\n   StdOut=/scratch/%u/%x-%j.out\n   StdErr=/scratch/%u/%x-%j.err\n   WorkDir=/scratch/kqr876\n   Command=/scratch/kqr876/train.sh\n'
                : '',
            stderr: '',
        }), () => false, () => ({ username: 'kqr876', homeDir: '/home/kqr876', cluster: 'galvani' }));

        const paths = await service.getHistoryJobPaths('123', { jobName: 'train', nodes: 'node01' });

        assert.equal(service.getUsername(), 'kqr876');
        assert.equal(paths.stdoutPath, '/scratch/kqr876/train-123.out');
    });
});
