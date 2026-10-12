import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SlurmCommandResult, SlurmCommandRunner, SlurmNotConnectedError, writeInput } from './slurmCommandRunner';

/** Arguments no shell can misread, sent unquoted so commands stay readable */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A Host alias from ~/.ssh/config or user@hostname: nothing ssh could take for an option */
const SSH_HOST = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/;

/** No terminal, and nothing forwarded either way: the cluster gets no access to this machine */
const LEAST_PRIVILEGE_OPTIONS = ['-T', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes'];

/** How long the shared connection stays open after its last command */
const CONTROL_PERSIST = '15m';

/** sshd allows 10 sessions per connection by default (MaxSessions); stay below it */
const MAX_CONCURRENT_COMMANDS = 8;

const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/** ssh's own exit code, as opposed to the remote command's */
const SSH_ERROR_EXIT_CODE = 255;

/**
 * Quotes one argument for the POSIX shell that runs commands on the cluster.
 * SSH always hands the remote command to a shell, so every argument of every
 * command goes through here.
 */
export function quoteShellArgument(arg: string): string {
    // Slurm arguments never need these, and some shells (csh) mishandle line breaks even inside quotes
    if (/[\0\r\n]/.test(arg)) {
        throw new Error('Command arguments cannot contain line breaks');
    }
    return PLAIN_ARGUMENT.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command line the cluster's shell runs, optionally from a directory on the cluster */
export function buildRemoteCommand(argv: readonly string[], cwd?: string): string {
    const command = argv.map(quoteShellArgument).join(' ');
    return cwd ? `cd -- ${quoteShellArgument(cwd)} && ${command}` : command;
}

/** Explains what's wrong with an SSH host setting, or returns undefined when it's usable */
export function validateSshHost(host: string): string | undefined {
    if (!host) {
        return 'Enter the SSH host of your cluster';
    }
    if (!SSH_HOST.test(host)) {
        return 'Use a Host alias from ~/.ssh/config or user@hostname, without spaces or options';
    }
    return undefined;
}

/**
 * Makes sure a directory exists that only the current user can enter, and
 * refuses one that anyone else could have created or changed.
 */
export function ensurePrivateDirectory(dir: string): void {
    try {
        fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }

    // lstat, so a symlink planted in a shared temp folder is refused rather than followed
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error(`${dir} must be a directory that only you can access`);
    }
}

/**
 * Where the shared connection's socket lives. Anyone who can open that socket
 * can run commands on the cluster as you without logging in, so it goes in
 * the per-user runtime directory where there is one, otherwise in a private
 * directory in the temp folder.
 */
export function getSocketDirectory(env: NodeJS.ProcessEnv = process.env): string {
    const runtimeDir = env.XDG_RUNTIME_DIR;
    return runtimeDir && path.isAbsolute(runtimeDir)
        ? path.join(runtimeDir, 'scode')
        : path.join(os.tmpdir(), `scode-${os.userInfo().uid}`);
}

/**
 * Socket paths hold at most 103 characters on macOS (107 on Linux), and
 * OpenSSH first binds to the path plus a 17-character temporary suffix.
 */
const MAX_SOCKET_PATH_LENGTH = 103 - 17;

/** The socket for one host, named by a short hash to leave room in the path */
export function getControlSocketPath(directory: string, host: string): string {
    const socketPath = path.join(directory, createHash('sha256').update(host).digest('hex').slice(0, 16));
    if (socketPath.length > MAX_SOCKET_PATH_LENGTH) {
        throw new Error(`the connection socket path ${socketPath} is too long for a Unix socket`);
    }
    return socketPath;
}

/** An ssh invocation that failed, with what ssh or the remote command reported */
export class SshProcessError extends Error {
    constructor(
        readonly code: number | string | undefined,
        readonly stderr: string,
        readonly timedOut: boolean,
    ) {
        super(stderr.trim() || `ssh exited with code ${code}`);
        this.name = 'SshProcessError';
    }
}

/** Runs the local ssh client with the given arguments, without a shell */
export type SshProcessRunner = (
    args: readonly string[],
    options: { maxBuffer?: number; timeout?: number; input?: string },
) => Promise<SlurmCommandResult>;

const runSshProcess: SshProcessRunner = (args, options) => new Promise((resolve, reject) => {
    const child = execFile(
        'ssh',
        args,
        { maxBuffer: options.maxBuffer, timeout: options.timeout, encoding: 'utf8' },
        (error, stdout, stderr) => error
            ? reject(new SshProcessError(error.code ?? undefined, stderr, error.killed === true))
            : resolve({ stdout, stderr }),
    );
    writeInput(child.stdin, options.input);
});

/**
 * Runs commands on a cluster through one shared SSH connection (OpenSSH's
 * ControlMaster). The user logs in once, in a terminal where OpenSSH handles
 * passwords, two-factor codes, and host keys itself; every command after that
 * reuses the connection without prompting, so this extension never sees a
 * secret and never trusts a host key on its own.
 */
export class SshConnection {
    private running = 0;
    private readonly waiting: (() => void)[] = [];

    constructor(
        readonly host: string,
        readonly socketPath: string,
        private readonly runSsh: SshProcessRunner = runSshProcess,
        private readonly socketExists: (socketPath: string) => boolean = fs.existsSync,
    ) {}

    /** Arguments for the login that opens the shared connection, to run where the user can answer prompts */
    loginArgs(): string[] {
        return [
            '-M', '-N', '-S', this.socketPath,
            '-o', `ControlPersist=${CONTROL_PERSIST}`,
            // Notice a dead network within two minutes, rather than leaving every command to time out
            '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4',
            ...LEAST_PRIVILEGE_OPTIONS,
            '--', this.host,
        ];
    }

    async isConnected(): Promise<boolean> {
        if (!this.socketExists(this.socketPath)) {
            return false;
        }
        try {
            await this.runSsh(this.controlArgs('check'), {});
            return true;
        } catch {
            return false;
        }
    }

    /** Closes the shared connection, for every window using it */
    async disconnect(): Promise<void> {
        try {
            await this.runSsh(this.controlArgs('exit'), {});
        } catch {
            // Already closed
        }
    }

    /** Removes the socket of a connection that didn't exit cleanly, which would stop a new one from opening */
    async removeStaleSocket(): Promise<void> {
        if (this.socketExists(this.socketPath) && !(await this.isConnected())) {
            fs.rmSync(this.socketPath, { force: true });
        }
    }

    readonly run: SlurmCommandRunner = async (argv, options) => {
        if (!this.socketExists(this.socketPath)) {
            throw new SlurmNotConnectedError(this.host);
        }

        const remoteCommand = buildRemoteCommand(argv, options?.cwd);
        await this.acquireSlot();
        try {
            return await this.runSsh(this.commandArgs(remoteCommand), {
                maxBuffer: options?.maxBuffer,
                timeout: COMMAND_TIMEOUT_MS,
                input: options?.input,
            });
        } catch (error) {
            if (error instanceof SshProcessError && error.code === SSH_ERROR_EXIT_CODE && !(await this.isConnected())) {
                throw new SlurmNotConnectedError(this.host);
            }
            // Name the Slurm command, not the ssh plumbing around it
            const stderr = error instanceof SshProcessError ? error.stderr : String(error);
            const timedOut = error instanceof SshProcessError && error.timedOut ? ' (timed out)' : '';
            throw new Error(`Command failed: ${argv.join(' ')}${timedOut}\n${stderr}`.trim());
        } finally {
            this.releaseSlot();
        }
    };

    private commandArgs(remoteCommand: string): string[] {
        return [
            '-S', this.socketPath,
            // Only ever use the shared connection, never start one
            '-o', 'ControlMaster=no',
            // ssh falls back to a connection of its own when the shared one is gone,
            // which would log in once per command; connecting through `false` makes
            // that fallback fail at once instead
            '-o', 'ProxyCommand=false',
            // Fail rather than prompt: passwords, two-factor codes, and changed host keys belong in the login terminal
            '-o', 'BatchMode=yes',
            '-o', 'LogLevel=ERROR',
            ...LEAST_PRIVILEGE_OPTIONS,
            '--', this.host, remoteCommand,
        ];
    }

    private controlArgs(operation: 'check' | 'exit'): string[] {
        return ['-S', this.socketPath, '-O', operation, '--', this.host];
    }

    private async acquireSlot(): Promise<void> {
        if (this.running < MAX_CONCURRENT_COMMANDS) {
            this.running++;
            return;
        }
        // The slot is handed over by releaseSlot, so the count stays the same
        await new Promise<void>(resolve => this.waiting.push(resolve));
    }

    private releaseSlot(): void {
        const next = this.waiting.shift();
        if (next) {
            next();
        } else {
            this.running--;
        }
    }
}
