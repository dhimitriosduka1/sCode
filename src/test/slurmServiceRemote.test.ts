import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmService } from '../slurmService';
import { SlurmCommandInvocation, SlurmCommandResult, SlurmExecutor } from '../slurmExecutor';

class FakeExecutor implements SlurmExecutor {
    readonly connectionKey: string;
    readonly calls: SlurmCommandInvocation[] = [];

    constructor(
        readonly kind: 'local' | 'ssh',
        private readonly handler: (invocation: SlurmCommandInvocation) => SlurmCommandResult | Promise<SlurmCommandResult>,
        connectionKey?: string,
    ) {
        this.connectionKey = connectionKey ?? (kind === 'ssh' ? 'ssh:cluster-login' : 'local');
    }

    async run(invocation: SlurmCommandInvocation): Promise<SlurmCommandResult> {
        this.calls.push(invocation);
        return this.handler(invocation);
    }
}

describe('SlurmService remote executor integration', () => {
    it('scopes cached remote paths by SSH connection key', async () => {
        const cachedKeys: string[] = [];
        const pathCache: any = {
            get: () => undefined,
            set: async (key: string) => {
                cachedKeys.push(key);
            },
        };
        const makeExecutor = (connectionKey: string) => new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'id') {
                return { stdout: 'remote-user\n', stderr: '' };
            }
            if (invocation.command === 'squeue') {
                return {
                    stdout: '123|train|R|00:01:00|h200|gpu-node01|01:00:00|2026-04-28T10:00:00|None\n',
                    stderr: '',
                };
            }
            if (invocation.command === 'scontrol') {
                return {
                    stdout: 'JobId=123 JobName=train StdOut=/logs/out-%j.txt StdErr=/logs/err-%j.txt Command=/remote/project/train.sbatch WorkDir=/remote/project',
                    stderr: '',
                };
            }
            if (invocation.command === 'nvidia-smi') {
                throw new Error('not available');
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        }, connectionKey);
        const service = new SlurmService(pathCache, undefined, makeExecutor('ssh:cluster-a'));

        await service.getJobs();
        service.setExecutor(makeExecutor('ssh:cluster-b'));
        await service.getJobs();

        assert.deepEqual(cachedKeys, [
            'ssh:cluster-a:123',
            'ssh:cluster-b:123',
        ]);
    });

    it('reports connection availability status without hiding the failure reason', async () => {
        const executor = new FakeExecutor('local', () => {
            throw new Error('Local Slurm command not found: squeue');
        });
        const service = new SlurmService(undefined, undefined, executor);

        assert.deepEqual(await service.getAvailabilityStatus(), {
            available: false,
            mode: 'local',
            message: 'Local Slurm command not found: squeue',
        });
    });

    it('uses the remote username for user-scoped job queries', async () => {
        const executor = new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'id') {
                return { stdout: 'remote-user\n', stderr: '' };
            }
            if (invocation.command === 'squeue') {
                assert.deepEqual(invocation.args?.slice(0, 2), ['-u', 'remote-user']);
                return {
                    stdout: '123|train|R|00:01:00|h200|gpu-node01|01:00:00|2026-04-28T10:00:00|None\n',
                    stderr: '',
                };
            }
            if (invocation.command === 'scontrol') {
                return {
                    stdout: 'JobId=123 JobName=train StdOut=logs/out-%j.txt StdErr=logs/err-%j.txt Command=train.sbatch WorkDir=/remote/project AllocTRES=gres/gpu:h200=2',
                    stderr: '',
                };
            }
            if (invocation.command === 'nvidia-smi') {
                throw new Error('not available');
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        });
        const service = new SlurmService(undefined, undefined, executor);

        const jobs = await service.getJobs();

        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].stdoutPath, '/remote/project/logs/out-123.txt');
        assert.equal(jobs[0].stderrPath, '/remote/project/logs/err-123.txt');
        assert.equal(jobs[0].submitScript, '/remote/project/train.sbatch');
        assert.equal(jobs[0].gpuCount, 2);
        assert.equal(jobs[0].gpuType, 'H200');
    });

    it('submits remote jobs only through explicit absolute remote paths', async () => {
        const executor = new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'sbatch') {
                assert.deepEqual(invocation.args, ['/remote/project/train.sbatch']);
                assert.equal(invocation.cwd, '/remote/project');
                return { stdout: 'Submitted batch job 456\n', stderr: '' };
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        });
        const service = new SlurmService(undefined, undefined, executor);

        assert.deepEqual(await service.submitJob('/remote/project/train.sbatch'), {
            success: true,
            jobId: '456',
            message: 'Job submitted successfully with ID: 456',
        });

        const originalConsoleError = console.error;
        console.error = () => undefined;
        let unsafeResult;
        try {
            unsafeResult = await service.submitJob('relative/train.sbatch');
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(unsafeResult.success, false);
        assert.match(unsafeResult.message, /Remote file path must be absolute/);
    });

    it('reads remote files after stat validation', async () => {
        const executor = new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'stat') {
                assert.deepEqual(invocation.args, ['-Lc', '%F|%s', '/remote/logs/job.out']);
                return { stdout: 'regular file|12\n', stderr: '' };
            }
            if (invocation.command === 'cat') {
                assert.deepEqual(invocation.args, ['/remote/logs/job.out']);
                return { stdout: 'hello world\n', stderr: '' };
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        });
        const service = new SlurmService(undefined, undefined, executor);

        assert.equal(await service.readRemoteFile('/remote/logs/job.out', 1024), 'hello world\n');
    });

    it('rejects unsafe remote file paths and oversized remote files', async () => {
        const oversizedExecutor = new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'stat') {
                return { stdout: 'regular file|2048\n', stderr: '' };
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        });
        const service = new SlurmService(undefined, undefined, oversizedExecutor);

        await assert.rejects(
            () => service.readRemoteFile('relative.out', 1024),
            /absolute/
        );
        await assert.rejects(
            () => service.readRemoteFile('/remote/logs/large.out', 1024),
            /too large/
        );
    });

    it('rejects malformed remote file metadata and directories before reading', async () => {
        const directoryExecutor = new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'stat') {
                return { stdout: 'directory|128\n', stderr: '' };
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        });
        const malformedExecutor = new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'stat') {
                return { stdout: 'regular file|not-a-number\n', stderr: '' };
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        });

        await assert.rejects(
            () => new SlurmService(undefined, undefined, directoryExecutor).readRemoteFile('/remote/logs', 1024),
            /not a regular file/
        );
        await assert.rejects(
            () => new SlurmService(undefined, undefined, malformedExecutor).readRemoteFile('/remote/logs/job.out', 1024),
            /Could not read remote file size/
        );
    });

    it('testConnection reports remote user and Slurm version', async () => {
        const executor = new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'id') {
                return { stdout: 'remote-user\n', stderr: '' };
            }
            if (invocation.command === 'squeue') {
                return { stdout: 'slurm 24.11.0\n', stderr: '' };
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        });
        const service = new SlurmService(undefined, undefined, executor);

        assert.deepEqual(await service.testConnection(), {
            success: true,
            message: 'Connected to cluster-login as remote-user. slurm 24.11.0',
        });
    });

    it('strips Slurm array throttle notation before remote scancel calls', async () => {
        const executor = new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'scancel') {
                return { stdout: '', stderr: '' };
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        });
        const service = new SlurmService(undefined, undefined, executor);

        assert.equal((await service.cancelJob('123_[0-10%2]')).success, true);
        assert.equal((await service.cancelJobByState('456_[0-20%4]', 'PENDING')).success, true);
        assert.deepEqual(executor.calls, [
            { command: 'scancel', args: ['123_[0-10]'] },
            { command: 'scancel', args: ['--state=PENDING', '456_[0-20]'] },
        ]);
    });

    it('routes overview, history, and cancellation commands through the executor', async () => {
        const executor = new FakeExecutor('ssh', (invocation) => {
            if (invocation.command === 'id') {
                return { stdout: 'remote-user\n', stderr: '' };
            }
            if (invocation.command === 'sinfo') {
                return { stdout: 'h200|2|1/1/0/2|gpu:h200:4\n', stderr: '' };
            }
            if (invocation.command === 'squeue' && invocation.args?.includes('--state=R')) {
                return { stdout: 'nova42|atlas_lab|gpu:h200:2\n', stderr: '' };
            }
            if (invocation.command === 'squeue') {
                return { stdout: 'h200|R|gpu:h200:2\n', stderr: '' };
            }
            if (invocation.command === 'sacct') {
                return {
                    stdout: '100|done|COMPLETED|0:0|2026-04-28T10:00:00|2026-04-28T10:05:00|00:05:00|h200|gpu-node01|4|1G\n',
                    stderr: '',
                };
            }
            if (invocation.command === 'scancel') {
                return { stdout: '', stderr: '' };
            }
            throw new Error(`Unexpected command: ${invocation.command}`);
        });
        const service = new SlurmService(undefined, undefined, executor);

        assert.equal((await service.getPartitionUsage())[0].partition, 'h200');
        assert.equal((await service.getClusterLeaderboard())[0].username, 'nova42');
        assert.equal((await service.getClusterAccountOverview())[0].account, 'atlas_lab');
        assert.equal((await service.getJobHistory(1))[0].jobId, '100');
        assert.deepEqual(await service.cancelAllPendingJobs(), {
            success: true,
            message: 'All pending jobs cancelled successfully',
        });

        assert.ok(executor.calls.some(call =>
            call.command === 'sacct' &&
            call.args?.[0] === '-u' &&
            call.args?.[1] === 'remote-user'
        ));
        assert.ok(executor.calls.some(call =>
            call.command === 'scancel' &&
            call.args?.includes('remote-user')
        ));
    });
});
