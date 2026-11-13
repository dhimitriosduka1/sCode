import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    buildControlArgs,
    buildMasterArgs,
    buildRemoteCommand,
    buildRunArgs,
    createSshCommandRunner,
    ensurePrivateSocketDir,
    ExecFileRunner,
    getMasterPid,
    getSocketPath,
    isMasterRunning,
    parseSshConfigUser,
    probeSocket,
    removeStaleSocket,
    resolveSshUser,
    SshTarget,
} from '../sshConnection';
import { quoteForShell } from '../shellQuote';
import * as net from 'net';
import { spawn } from 'child_process';

const TARGET: SshTarget = { alias: 'raven', socketPath: '/tmp/scode-ssh-501/0123456789abcdef' };

function optionValues(args: string[]): string[] {
    return args.flatMap((arg, index) => (args[index - 1] === '-o' ? [arg] : []));
}

describe('quoteForShell', () => {
    it('makes any value one literal word for the shell', () => {
        assert.equal(quoteForShell('/scratch/ada/run 1'), `'/scratch/ada/run 1'`);
        assert.equal(quoteForShell(`it's $HOME; rm -rf ~`), `'it'\\''s $HOME; rm -rf ~'`);
    });
});

describe('buildRemoteCommand', () => {
    it('runs from the quoted folder when given one, leaving the command to the shell', () => {
        assert.equal(buildRemoteCommand('squeue -u $USER'), 'squeue -u $USER');
        assert.equal(buildRemoteCommand('sbatch "train.sh"', "/scratch/ada's runs"), `cd '/scratch/ada'\\''s runs' && sbatch "train.sh"`);
    });
});

describe('buildRunArgs', () => {
    it('reuses the master, never prompts and ends ssh options before the command', () => {
        const args = buildRunArgs(TARGET, 'squeue -u $USER');

        // `--` first, so no alias can be read as an option
        assert.deepEqual(args.slice(-3), ['--', 'raven', 'squeue -u $USER']);
        assert.ok(optionValues(args).includes(`ControlPath=${TARGET.socketPath}`));
        assert.ok(optionValues(args).includes('ControlMaster=no'));
        assert.ok(optionValues(args).includes('BatchMode=yes'));
    });

    it('turns off the config\'s forwards, RemoteCommand and LocalCommand', () => {
        for (const args of [buildRunArgs(TARGET, 'true'), buildMasterArgs(TARGET, 'background'), buildMasterArgs(TARGET, 'terminal')]) {
            const options = optionValues(args);
            for (const option of ['ClearAllForwardings=yes', 'RemoteCommand=none', 'PermitLocalCommand=no', 'ForwardAgent=no', 'ForwardX11=no']) {
                assert.ok(options.includes(option), option);
            }
        }
    });

    it('never weakens host key checking', () => {
        for (const args of [buildRunArgs(TARGET, 'true'), buildMasterArgs(TARGET, 'background'), buildMasterArgs(TARGET, 'terminal')]) {
            assert.ok(!args.some((arg) => /StrictHostKeyChecking|UserKnownHostsFile/i.test(arg)));
        }
    });
});

describe('buildMasterArgs', () => {
    it('never lets the background master prompt', () => {
        const background = buildMasterArgs(TARGET, 'background');

        assert.deepEqual(background.slice(0, 2), ['-M', '-N']);
        assert.ok(optionValues(background).includes('BatchMode=yes'));
        assert.ok(optionValues(background).includes('ServerAliveInterval=15'));
        assert.deepEqual(background.slice(-2), ['--', 'raven']);
    });

    it('lets the terminal master prompt, then fork so it outlives the terminal', () => {
        const terminal = buildMasterArgs(TARGET, 'terminal');

        assert.deepEqual(terminal.slice(0, 3), ['-M', '-N', '-f']);
        assert.ok(!optionValues(terminal).includes('BatchMode=yes'));
        assert.deepEqual(terminal.slice(-2), ['--', 'raven']);
    });

    // A reloaded window finds the connection still open, and one nobody uses
    // any more closes itself, since the window cannot tell a reload from closing
    it('keeps either master open for 2 hours after its last use', () => {
        for (const mode of ['background', 'terminal'] as const) {
            assert.ok(optionValues(buildMasterArgs(TARGET, mode)).includes('ControlPersist=2h'), mode);
        }
    });
});

describe('buildControlArgs', () => {
    it('addresses the master on its socket', () => {
        assert.deepEqual(buildControlArgs(TARGET, 'check'), ['-O', 'check', '-o', `ControlPath=${TARGET.socketPath}`, '--', 'raven']);
    });
});

describe('createSshCommandRunner', () => {
    it('runs ssh directly with the command for the cluster, passing the folder and buffer size', async () => {
        const calls: { file: string; args: string[]; options: object }[] = [];
        const run: ExecFileRunner = async (file, args, options) => {
            calls.push({ file, args, options });
            return { stdout: 'Submitted batch job 7\n', stderr: '' };
        };

        const result = await createSshCommandRunner(TARGET, run)('sbatch "train.sh"', { cwd: '/scratch/ada', maxBuffer: 1024 });

        assert.deepEqual(result, { stdout: 'Submitted batch job 7\n', stderr: '' });
        assert.equal(calls[0].file, 'ssh');
        assert.equal(calls[0].args[calls[0].args.length - 1], `cd '/scratch/ada' && sbatch "train.sh"`);
        assert.deepEqual(calls[0].options, { maxBuffer: 1024, timeout: undefined });
    });

    it('passes on failures with their exit code, so a dropped connection can be told apart', async () => {
        const failure = Object.assign(new Error('ssh failed'), { code: 255, stdout: '', stderr: 'Connection closed' });
        const runner = createSshCommandRunner(TARGET, async () => {
            throw failure;
        });

        await assert.rejects(runner('squeue'), (error) => error === failure);
    });
});

describe('getMasterPid', () => {
    it('reads the pid ssh -O check reports for the master', async () => {
        assert.equal(await getMasterPid(TARGET, async () => ({ stdout: '', stderr: 'Master running (pid=4242)\r\n' })), 4242);
        assert.equal(await getMasterPid(TARGET, async () => ({ stdout: '', stderr: '' })), undefined);
    });
});

describe('isMasterRunning', () => {
    it('asks the master to check itself, and treats any failure as not running', async () => {
        const commands: string[][] = [];
        assert.equal(await isMasterRunning(TARGET, async (_file, args) => {
            commands.push(args);
            return { stdout: '', stderr: 'Master running (pid=4242)' };
        }), true);
        assert.deepEqual(commands, [buildControlArgs(TARGET, 'check')]);

        assert.equal(await isMasterRunning(TARGET, async () => {
            throw new Error('Control socket connect: No such file or directory');
        }), false);
    });
});

describe('ensurePrivateSocketDir', () => {
    it('creates a folder only this user can open, and reuses it', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-sock-'));
        try {
            const dir = ensurePrivateSocketDir(base);

            assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
            assert.equal(ensurePrivateSocketDir(base), dir);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it('refuses a folder others can open, or a symlink in its place', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-sock-'));
        const dir = path.join(base, `scode-ssh-${process.getuid?.() ?? 0}`);
        try {
            fs.mkdirSync(dir);
            fs.chmodSync(dir, 0o755);
            assert.throws(() => ensurePrivateSocketDir(base), /only you can access/);

            fs.rmSync(dir, { recursive: true });
            const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-elsewhere-'));
            fs.chmodSync(elsewhere, 0o700);
            fs.symlinkSync(elsewhere, dir);
            assert.throws(() => ensurePrivateSocketDir(base), /only you can access/);
            fs.rmSync(elsewhere, { recursive: true, force: true });
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });
});

describe('getSocketPath', () => {
    it('names the socket after a short hash of the alias', () => {
        const socketPath = getSocketPath('raven', '/tmp/scode-ssh-501');

        assert.match(socketPath, /^\/tmp\/scode-ssh-501\/[0-9a-f]{16}$/);
        assert.equal(getSocketPath('raven', '/tmp/scode-ssh-501'), socketPath);
        assert.notEqual(getSocketPath('raven-i', '/tmp/scode-ssh-501'), socketPath);
    });

    it('leaves room for the 17 characters ssh adds while binding', () => {
        // 86 bytes fit; ssh briefly needs 103, the most a macOS socket path can take
        assert.doesNotThrow(() => getSocketPath('raven', `/${'x'.repeat(68)}`));
        assert.throws(() => getSocketPath('raven', `/${'x'.repeat(69)}`), /too long/);
    });

    it('refuses folders whose path ssh would split or expand', () => {
        for (const dir of ['/tmp/my folder', '/tmp/100%', '~/sockets', `/tmp/it's`]) {
            assert.throws(() => getSocketPath('raven', dir), /characters ssh cannot take/, dir);
        }
    });
});

describe('probeSocket and removeStaleSocket', () => {
    it('tells a live socket from a leftover, and removes only the leftover', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-probe-'));
        const livePath = path.join(dir, 'live');
        const stalePath = path.join(dir, 'stale');
        const server = net.createServer().listen(livePath);
        await new Promise((resolve) => server.once('listening', resolve));
        try {
            // A process killed outright leaves its socket file behind, as a crashed master does
            const holder = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(stalePath)}, () => console.log('up'))`]);
            await new Promise((resolve) => holder.stdout.once('data', resolve));
            holder.kill('SIGKILL');
            await new Promise((resolve) => holder.once('exit', resolve));
            assert.ok(fs.existsSync(stalePath));

            assert.equal(await probeSocket(livePath), 'live');
            assert.equal(await probeSocket(stalePath), 'stale');
            assert.equal(await probeSocket(path.join(dir, 'missing')), 'missing');

            await removeStaleSocket({ alias: 'raven', socketPath: livePath });
            await removeStaleSocket({ alias: 'raven', socketPath: stalePath });
            assert.ok(fs.existsSync(livePath), 'a socket something answers on stays');
            assert.ok(!fs.existsSync(stalePath), 'a leftover goes');
        } finally {
            server.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('resolveSshUser', () => {
    it('reads the account ssh -G says it logs in as, without connecting', async () => {
        const calls: string[][] = [];
        const user = await resolveSshUser('galvani', async (_file, args) => {
            calls.push(args);
            return { stdout: 'host galvani\nhostname galvani-login.example.org\nuser kqr876\nport 22\n', stderr: '' };
        });

        assert.equal(user, 'kqr876');
        assert.deepEqual(calls, [['-G', '--', 'galvani']]);
    });

    it('knows no user when ssh cannot work out the config', async () => {
        assert.equal(await resolveSshUser('galvani', async () => {
            throw new Error('Bad configuration option');
        }), undefined);
        assert.equal(parseSshConfigUser('host galvani\nport 22\n'), undefined);
    });
});
