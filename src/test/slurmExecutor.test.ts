import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    ExecFileRunner,
    isTransientSshStartupError,
    LocalSlurmExecutor,
    posixShellQuote,
    SshSlurmExecutor,
    validateJobId,
    validatePartitionName,
    validateRemoteFilePath,
} from '../slurmExecutor';
import { supportsSshControlMaster } from '../sshConfig';

const noopPrepareControlDirectory = () => {};

describe('Slurm executors', () => {
    it('runs local commands through execFile without a shell command string', async () => {
        const calls: Array<{ file: string; args: readonly string[] }> = [];
        const runner: ExecFileRunner = async (file, args) => {
            calls.push({ file, args });
            return { stdout: 'ok', stderr: '' };
        };

        const executor = new LocalSlurmExecutor(runner);
        const result = await executor.run({
            command: 'squeue',
            args: ['--noheader', '--format=%i|%j'],
        });

        assert.deepEqual(result, { stdout: 'ok', stderr: '' });
        assert.deepEqual(calls, [{
            file: 'squeue',
            args: ['--noheader', '--format=%i|%j'],
        }]);
    });

    it('builds SSH invocations with BatchMode and ConnectTimeout', async () => {
        const calls: Array<{ file: string; args: readonly string[] }> = [];
        const runner: ExecFileRunner = async (file, args) => {
            calls.push({ file, args });
            return { stdout: 'ok', stderr: '' };
        };

        const executor = new SshSlurmExecutor({
            host: 'cluster-login',
            connectTimeoutSeconds: 7,
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
        });

        await executor.run({
            command: 'scontrol',
            args: ['show', 'job', '123_[1,3]'],
        });

        assert.equal(calls[0].file, 'ssh');
        assert.deepEqual(calls[0].args.slice(0, 4), [
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=7',
        ]);
        assert.ok(calls[0].args.includes('ServerAliveInterval=60'));
        if (supportsSshControlMaster()) {
            assert.ok(calls[0].args.includes('ControlMaster=auto'));
            assert.ok(calls[0].args.includes('ControlPersist=8h'));
            assert.ok(calls[0].args.some(arg => String(arg).startsWith('ControlPath=') && String(arg).includes('cm-%C')));
        } else {
            assert.ok(!calls[0].args.includes('ControlMaster=auto'));
            assert.ok(!calls[0].args.some(arg => String(arg).startsWith('ControlPath=')));
        }
        assert.equal(calls[0].args.at(-2), 'cluster-login');
        assert.equal(calls[0].args.at(-1), "scontrol 'show' 'job' '123_[1,3]'");
    });

    it('clamps SSH connection timeouts to a safe range', async () => {
        const calls: Array<{ file: string; args: readonly string[] }> = [];
        const runner: ExecFileRunner = async (file, args) => {
            calls.push({ file, args });
            return { stdout: 'ok', stderr: '' };
        };

        await new SshSlurmExecutor({
            host: 'cluster-login',
            connectTimeoutSeconds: -5,
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
        }).run({ command: 'id', args: ['-un'] });
        await new SshSlurmExecutor({
            host: 'cluster-login',
            connectTimeoutSeconds: 999,
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
        }).run({ command: 'id', args: ['-un'] });

        assert.equal(calls[0].args[3], 'ConnectTimeout=1');
        assert.equal(calls[1].args[3], 'ConnectTimeout=120');
    });

    it('serializes concurrent SSH invocations to avoid login-node connection bursts', async () => {
        const startedCommands: string[] = [];
        let releaseFirstCommand: (() => void) | undefined;
        const firstCommandRunning = new Promise<void>(resolve => {
            releaseFirstCommand = resolve;
        });

        const runner: ExecFileRunner = async (_file, args) => {
            const remoteCommand = String(args.at(-1));
            startedCommands.push(remoteCommand);
            if (remoteCommand === "id '-un'") {
                await firstCommandRunning;
            }
            return { stdout: 'ok', stderr: '' };
        };

        const executor = new SshSlurmExecutor({
            host: 'cluster-login',
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
        });

        const firstRun = executor.run({ command: 'id', args: ['-un'] });
        const secondRun = executor.run({ command: 'squeue', args: ['--version'] });

        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(startedCommands, ["id '-un'"]);

        releaseFirstCommand?.();
        await Promise.all([firstRun, secondRun]);

        assert.deepEqual(startedCommands, [
            "id '-un'",
            "squeue '--version'",
        ]);
    });

    it('retries transient SSH startup failures before surfacing an error', async () => {
        let attempts = 0;
        const runner: ExecFileRunner = async () => {
            attempts++;
            if (attempts === 1) {
                const error = new Error('Command failed') as Error & { stderr: string };
                error.stderr = 'kex_exchange_identification: Connection closed by remote host\nConnection closed by 139.19.94.40 port 22';
                throw error;
            }

            return { stdout: 'ok', stderr: '' };
        };

        const executor = new SshSlurmExecutor({
            host: 'cluster-login',
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
            retryDelayMs: () => 0,
        });

        assert.deepEqual(await executor.run({ command: 'id', args: ['-un'] }), { stdout: 'ok', stderr: '' });
        assert.equal(attempts, 2);
    });

    it('reports exhausted transient SSH startup failures with actionable context', async () => {
        const runner: ExecFileRunner = async () => {
            const error = new Error('Command failed') as Error & { stderr: string };
            error.stderr = 'kex_exchange_identification: Connection closed by remote host';
            throw error;
        };

        const executor = new SshSlurmExecutor({
            host: 'cluster-login',
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
            retryDelayMs: () => 0,
        });

        await assert.rejects(
            () => executor.run({ command: 'id', args: ['-un'] }),
            /retries.*connection still failed|retried automatically/i
        );
    });

    it('detects transient SSH startup failures from OpenSSH stderr', () => {
        const error = new Error('Command failed') as Error & { stderr: string };
        error.stderr = 'kex_exchange_identification: Connection closed by remote host\nConnection closed by 139.19.94.40 port 22';

        assert.equal(isTransientSshStartupError(error), true);
        assert.equal(isTransientSshStartupError(new Error('Permission denied (publickey,password).')), false);
    });

    it('quotes remote arguments with spaces and single quotes', () => {
        assert.equal(
            posixShellQuote("/work/project/logs/weird 'file'.out"),
            "'/work/project/logs/weird '\\''file'\\''.out'"
        );
    });

    it('serializes remote working directories without interpolating raw input', () => {
        const executor = new SshSlurmExecutor({ host: 'cluster-login', prepareControlDirectory: noopPrepareControlDirectory });

        assert.equal(
            executor.buildRemoteCommand({
                command: 'sbatch',
                args: ["/work/project/run's job.sbatch"],
                cwd: "/work/project/run's",
            }),
            "cd '/work/project/run'\\''s' && sbatch '/work/project/run'\\''s job.sbatch'"
        );
    });

    it('rejects relative remote working directories', () => {
        const executor = new SshSlurmExecutor({ host: 'cluster-login', prepareControlDirectory: noopPrepareControlDirectory });

        assert.throws(
            () => executor.buildRemoteCommand({
                command: 'sbatch',
                args: ['train.sbatch'],
                cwd: 'relative/path',
            }),
            /absolute/
        );
    });

    it('rejects unsupported commands and unsafe arguments', async () => {
        const executor = new SshSlurmExecutor({ host: 'cluster-login', prepareControlDirectory: noopPrepareControlDirectory });

        await assert.rejects(
            () => executor.run({ command: 'bash', args: ['-lc', 'whoami'] }),
            /Unsupported command/
        );
        await assert.rejects(
            () => executor.run({ command: 'cat', args: ['/tmp/a\nb'] }),
            /control character/
        );
    });

    it('rejects unsafe SSH host values before spawning ssh', async () => {
        await assert.rejects(
            () => new SshSlurmExecutor({ host: '-oProxyCommand=bad' }).run({ command: 'id', args: ['-un'] }),
            /SSH host/
        );
        await assert.rejects(
            () => new SshSlurmExecutor({ host: 'cluster login' }).run({ command: 'id', args: ['-un'] }),
            /SSH host/
        );
    });

    it('reports a clear message when local Slurm commands are missing', async () => {
        const runner: ExecFileRunner = async () => {
            const error = new Error('spawn squeue ENOENT') as Error & { code: string };
            error.code = 'ENOENT';
            throw error;
        };
        const executor = new LocalSlurmExecutor(runner);

        await assert.rejects(
            () => executor.run({ command: 'squeue', args: ['--version'] }),
            /Local Slurm command not found: squeue/
        );
    });

    it('reports a clear message when the OpenSSH client is missing', async () => {
        const runner: ExecFileRunner = async () => {
            const error = new Error('spawn ssh ENOENT') as Error & { code: string };
            error.code = 'ENOENT';
            throw error;
        };
        const executor = new SshSlurmExecutor({
            host: 'cluster-login',
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
        });

        await assert.rejects(
            () => executor.run({ command: 'squeue', args: ['--version'] }),
            /OpenSSH client not found: ssh/
        );
    });

    it('reports a clear message when remote Slurm commands are missing from PATH', async () => {
        const runner: ExecFileRunner = async () => {
            const error = new Error('Command failed') as Error & { stderr: string };
            error.stderr = 'bash: line 1: squeue: command not found';
            throw error;
        };
        const executor = new SshSlurmExecutor({
            host: 'cluster-login',
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
        });

        await assert.rejects(
            () => executor.run({ command: 'squeue', args: ['--version'] }),
            /Remote Slurm command not found: squeue/
        );
    });

    it('reports a clear message when SSH authentication requires an interactive password', async () => {
        const runner: ExecFileRunner = async () => {
            const error = new Error('Command failed') as Error & { stderr: string };
            error.stderr = 'dduka@raven.mpcdf.mpg.de: Permission denied (gssapi-with-mic,password).';
            throw error;
        };
        const executor = new SshSlurmExecutor({
            host: 'dduka@raven.mpcdf.mpg.de',
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
        });

        await assert.rejects(
            () => executor.run({ command: 'id', args: ['-un'] }),
            /password prompts are not supported/
        );
    });

    it('reports a clear message for SSH host-key verification failures', async () => {
        const runner: ExecFileRunner = async () => {
            const error = new Error('Command failed') as Error & { stderr: string };
            error.stderr = 'Host key verification failed.';
            throw error;
        };
        const executor = new SshSlurmExecutor({
            host: 'cluster-login',
            execFileRunner: runner,
            prepareControlDirectory: noopPrepareControlDirectory,
        });

        await assert.rejects(
            () => executor.run({ command: 'id', args: ['-un'] }),
            /host-key verification failed/
        );
    });

    it('validates Slurm identifiers used in remote commands', () => {
        assert.doesNotThrow(() => validateJobId('123'));
        assert.doesNotThrow(() => validateJobId('123_4'));
        assert.doesNotThrow(() => validateJobId('123_[1,3-5]'));
        assert.doesNotThrow(() => validateJobId('123_[0-10%2]'));
        assert.doesNotThrow(() => validateJobId('123_[0-10:2%3]'));
        assert.throws(() => validateJobId('123;rm -rf /'), /Unsafe job ID/);
        assert.throws(() => validateJobId('123_[0-10%2,12]'), /Unsafe job ID/);

        assert.doesNotThrow(() => validatePartitionName('a100-long'));
        assert.throws(() => validatePartitionName('gpu;hostname'), /Unsafe partition name/);

        assert.doesNotThrow(() => validateRemoteFilePath('/work/logs/job.out'));
        assert.throws(() => validateRemoteFilePath('logs/job.out'), /absolute/);
    });
});
