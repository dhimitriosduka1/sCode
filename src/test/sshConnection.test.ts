import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SlurmNotConnectedError } from '../slurmCommandRunner';
import {
    buildRemoteCommand,
    ensurePrivateDirectory,
    getControlSocketPath,
    getSocketDirectory,
    quoteShellArgument,
    SshConnection,
    SshProcessError,
    SshProcessRunner,
    validateSshHost,
} from '../sshConnection';

const SOCKET = '/run/user/1000/scode/0123456789abcdef';

function createConnection(runSsh: SshProcessRunner, socketExists = true): SshConnection {
    return new SshConnection('mycluster', SOCKET, runSsh, () => socketExists);
}

/** The remote command is the last argument; everything before the host is ssh's own */
function splitSshArgs(args: readonly string[]): { sshOptions: readonly string[]; host: string; remoteCommand: string } {
    const separator = args.indexOf('--');
    return { sshOptions: args.slice(0, separator), host: args[separator + 1], remoteCommand: args[separator + 2] };
}

describe('quoteShellArgument', () => {
    it('leaves plain arguments readable', () => {
        assert.equal(quoteShellArgument('squeue'), 'squeue');
        assert.equal(quoteShellArgument('--state=PENDING'), '--state=PENDING');
        assert.equal(quoteShellArgument('jobid=123_4'), 'jobid=123_4');
        assert.equal(quoteShellArgument('/work/alice/logs/1.out'), '/work/alice/logs/1.out');
    });

    it('quotes anything a shell would interpret', () => {
        assert.equal(quoteShellArgument('--format=%i|%j'), `'--format=%i|%j'`);
        assert.equal(quoteShellArgument('a100; rm -rf ~'), `'a100; rm -rf ~'`);
        assert.equal(quoteShellArgument('$(id)'), `'$(id)'`);
        assert.equal(quoteShellArgument('~/logs'), `'~/logs'`);
        assert.equal(quoteShellArgument(''), `''`);
    });

    it('escapes single quotes so they cannot end the quoting', () => {
        assert.equal(quoteShellArgument(`it's`), `'it'\\''s'`);
        assert.equal(quoteShellArgument(`'; touch /tmp/x; '`), `''\\''; touch /tmp/x; '\\'''`);
    });

    it('refuses line breaks', () => {
        assert.throws(() => quoteShellArgument('a\nb'), /line breaks/);
        assert.throws(() => quoteShellArgument('a\rb'), /line breaks/);
    });
});

describe('buildRemoteCommand', () => {
    it('quotes each argument separately', () => {
        assert.equal(
            buildRemoteCommand(['squeue', '-u', 'alice', '--format=%i|%j']),
            `squeue -u alice '--format=%i|%j'`,
        );
    });

    it('runs from a directory on the cluster', () => {
        assert.equal(
            buildRemoteCommand(['sbatch', 'train.sbatch'], '/work/my runs'),
            `cd -- '/work/my runs' && sbatch train.sbatch`,
        );
    });
});

describe('validateSshHost', () => {
    it('accepts Host aliases and user@hostname', () => {
        for (const host of ['mycluster', 'login.cluster.example.org', 'alice@login01', 'raven_gpu-1']) {
            assert.equal(validateSshHost(host), undefined, host);
        }
    });

    it('refuses anything ssh could read as an option or a shell could interpret', () => {
        for (const host of ['', '-oProxyCommand=touch /tmp/x', '-p', 'my cluster', 'host;id', 'host$(id)', 'host\nother']) {
            assert.ok(validateSshHost(host), JSON.stringify(host));
        }
    });
});

describe('socket location', () => {
    it('uses the per-user runtime directory where there is one', () => {
        assert.equal(getSocketDirectory({ XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/scode');
    });

    it('falls back to a per-user directory in the temp folder', () => {
        const expected = path.join(os.tmpdir(), `scode-${os.userInfo().uid}`);
        assert.equal(getSocketDirectory({}), expected);
        assert.equal(getSocketDirectory({ XDG_RUNTIME_DIR: 'relative/dir' }), expected);
    });

    it('names sockets per host, short enough for a socket path', () => {
        const first = getControlSocketPath('/run/user/1000/scode', 'mycluster');
        assert.equal(first, getControlSocketPath('/run/user/1000/scode', 'mycluster'));
        assert.notEqual(first, getControlSocketPath('/run/user/1000/scode', 'othercluster'));
        assert.equal(path.basename(first).length, 16);
    });

    it('refuses a socket path OpenSSH could not bind', () => {
        assert.throws(() => getControlSocketPath(`/${'x'.repeat(80)}`, 'mycluster'), /too long/);
    });
});

describe('ensurePrivateDirectory', () => {
    function withTempDir(test: (dir: string) => void): void {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-test-'));
        try {
            test(parent);
        } finally {
            fs.rmSync(parent, { recursive: true, force: true });
        }
    }

    it('creates a directory only its owner can enter', () => {
        withTempDir(parent => {
            const dir = path.join(parent, 'sockets');
            ensurePrivateDirectory(dir);
            assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
            // And accepts it the next time
            ensurePrivateDirectory(dir);
        });
    });

    it('refuses a directory others can enter', () => {
        withTempDir(parent => {
            const dir = path.join(parent, 'sockets');
            fs.mkdirSync(dir, { mode: 0o755 });
            fs.chmodSync(dir, 0o755);
            assert.throws(() => ensurePrivateDirectory(dir), /only you can access/);
        });
    });

    it('refuses a symlink rather than following it', () => {
        withTempDir(parent => {
            const target = path.join(parent, 'elsewhere');
            fs.mkdirSync(target, { mode: 0o700 });
            const link = path.join(parent, 'sockets');
            fs.symlinkSync(target, link);
            assert.throws(() => ensurePrivateDirectory(link), /only you can access/);
        });
    });
});

describe('SshConnection', () => {
    it('logs in with a shared connection that forwards nothing', () => {
        const args = createConnection(async () => ({ stdout: '', stderr: '' })).loginArgs();
        const { sshOptions, host, remoteCommand } = splitSshArgs(args);

        assert.equal(host, 'mycluster');
        assert.equal(remoteCommand, undefined);
        for (const option of ['-M', '-N', '-T']) {
            assert.ok(sshOptions.includes(option), option);
        }
        assert.equal(sshOptions[sshOptions.indexOf('-S') + 1], SOCKET);
        for (const option of ['ControlPersist=15m', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes']) {
            assert.ok(sshOptions.includes(option), option);
        }
    });

    it('runs commands over the shared connection without ever prompting', async () => {
        const calls: (readonly string[])[] = [];
        const connection = createConnection(async args => {
            calls.push(args);
            return { stdout: 'alice\n', stderr: '' };
        });

        const result = await connection.run(['squeue', '-u', 'alice', '--format=%i|%j'], { maxBuffer: 1024 });
        const { sshOptions, host, remoteCommand } = splitSshArgs(calls[0]);

        assert.equal(result.stdout, 'alice\n');
        assert.equal(host, 'mycluster');
        assert.equal(remoteCommand, `squeue -u alice '--format=%i|%j'`);
        assert.equal(sshOptions[sshOptions.indexOf('-S') + 1], SOCKET);
        for (const option of ['ControlMaster=no', 'ProxyCommand=false', 'BatchMode=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes', '-T']) {
            assert.ok(sshOptions.includes(option), option);
        }
    });

    it('reports a missing connection without running ssh', async () => {
        let ran = false;
        const connection = createConnection(async () => {
            ran = true;
            return { stdout: '', stderr: '' };
        }, false);

        await assert.rejects(connection.run(['squeue', '--version']), SlurmNotConnectedError);
        assert.equal(ran, false);
        assert.equal(await connection.isConnected(), false);
    });

    it('reports a dropped connection when ssh itself fails and the connection is gone', async () => {
        const connection = createConnection(async args => {
            throw new SshProcessError(255, args.includes('-O') ? 'No such master' : 'Connection closed', false);
        });

        await assert.rejects(connection.run(['squeue', '--version']), SlurmNotConnectedError);
    });

    it('names the Slurm command, not the ssh plumbing, when a command fails', async () => {
        const connection = createConnection(async args => {
            if (args.includes('-O')) {
                return { stdout: '', stderr: '' };
            }
            throw new SshProcessError(1, 'scancel: error: Invalid job id specified\n', false);
        });

        await assert.rejects(connection.run(['scancel', '123']), (error: Error) => {
            assert.equal(error.message, 'Command failed: scancel 123\nscancel: error: Invalid job id specified');
            assert.doesNotMatch(error.message, /ControlMaster|BatchMode/);
            return true;
        });
    });

    it('checks and closes the connection through its socket', async () => {
        const calls: (readonly string[])[] = [];
        const connection = createConnection(async args => {
            calls.push(args);
            return { stdout: '', stderr: '' };
        });

        assert.equal(await connection.isConnected(), true);
        await connection.disconnect();

        assert.deepEqual(calls, [
            ['-S', SOCKET, '-O', 'check', '--', 'mycluster'],
            ['-S', SOCKET, '-O', 'exit', '--', 'mycluster'],
        ]);
    });

    it('keeps fewer commands in flight than sshd allows sessions', async () => {
        let inFlight = 0;
        let mostInFlight = 0;
        const connection = createConnection(async () => {
            inFlight++;
            mostInFlight = Math.max(mostInFlight, inFlight);
            await new Promise(resolve => setTimeout(resolve, 5));
            inFlight--;
            return { stdout: '', stderr: '' };
        });

        await Promise.all(Array.from({ length: 30 }, (_, i) => connection.run(['scontrol', 'show', 'job', String(i)])));

        assert.equal(mostInFlight, 8);
        assert.equal(inFlight, 0);
    });
});

describe('command input', () => {
    it('reaches a local command on its standard input', async () => {
        const { localCommandRunner } = await import('../slurmCommandRunner');
        assert.equal((await localCommandRunner(['cat'], { input: '#!/bin/bash\necho hi\n' })).stdout, '#!/bin/bash\necho hi\n');
    });

    it('closes a local command\'s input when there is none, so it does not wait', async () => {
        const { localCommandRunner } = await import('../slurmCommandRunner');
        assert.equal((await localCommandRunner(['cat'])).stdout, '');
    });

    it('is passed through the shared connection', async () => {
        const inputs: (string | undefined)[] = [];
        const connection = createConnection(async (_args, options) => {
            inputs.push(options.input);
            return { stdout: '', stderr: '' };
        });

        await connection.run(['sbatch'], { input: 'script', cwd: '/work' });

        assert.deepEqual(inputs, ['script']);
    });
});
