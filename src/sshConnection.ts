import { ChildProcess, execFile, ExecFileOptions, spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { quoteForShell } from './shellQuote';
import type { SlurmCommandRunner } from './slurmService';

/**
 * Slurm over SSH, through the system `ssh` so that OpenSSH alone handles keys,
 * passwords, 2FA and host key checks, exactly as in a terminal. One master
 * connection per host is signed in once, and every command reuses it through a
 * control socket (ControlMaster), so commands neither sign in again nor pay for
 * a handshake.
 */

/** A host to run commands on, and the control socket its master listens on. */
export interface SshTarget {
    alias: string;
    socketPath: string;
}

/**
 * Settings that keep the extension's connections free of side effects the
 * user's config may ask for in interactive sessions: port forwards (which would
 * clash with the user's own sessions), a RemoteCommand (which ssh refuses to
 * combine with ours), LocalCommand, and forwarding the agent or X11, which would
 * hand the cluster access to them for as long as the connection stays open.
 */
const SIDE_EFFECT_FREE_OPTIONS = [
    '-o', 'ClearAllForwardings=yes',
    '-o', 'RemoteCommand=none',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
];

/**
 * Unix socket paths are capped at 104 bytes on macOS, terminator included, and
 * ssh first binds the socket under a temporary name 17 characters longer
 * (`<path>.<16 random characters>`) before moving it into place.
 */
const MAX_SOCKET_PATH_LENGTH = 103 - 17;

/** No prompt may ever come from a graphical askpass helper either; signing in happens in a terminal. */
const SSH_ENV = { ...process.env, SSH_ASKPASS_REQUIRE: 'never' };

/** The command line sent to the cluster's shell, run from `cwd` when given. */
export function buildRemoteCommand(command: string, cwd?: string): string {
    return cwd ? `cd ${quoteForShell(cwd)} && ${command}` : command;
}

/**
 * Arguments for running one command over the master connection. BatchMode
 * means a command can never stop to ask for a password: signing in only ever
 * happens when the master starts. `--` ends ssh's options before the alias, so
 * no alias can be read as one.
 */
export function buildRunArgs(target: SshTarget, remoteCommand: string): string[] {
    return [
        '-o', `ControlPath=${target.socketPath}`,
        '-o', 'ControlMaster=no',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        ...SIDE_EFFECT_FREE_OPTIONS,
        '-T',
        '--',
        target.alias,
        remoteCommand,
    ];
}

/**
 * Arguments for starting the master, which signs in and then serves the control
 * socket without running anything (`-N`) until it is told to exit or the server
 * stops answering keepalives (about 45 s).
 *
 * - `background`: never prompts (BatchMode) and stays in the foreground of the
 *   process the extension spawned, so the extension knows its pid and can stop
 *   it whatever happens to the socket.
 * - `terminal`: prompts in the terminal it runs in, then forks into the
 *   background (`-f`) once signed in, so it outlives the terminal.
 */
export function buildMasterArgs(target: SshTarget, mode: 'background' | 'terminal'): string[] {
    return [
        '-M', '-N',
        ...(mode === 'terminal' ? ['-f'] : []),
        '-o', `ControlPath=${target.socketPath}`,
        '-o', 'ControlPersist=no',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ConnectTimeout=15',
        ...(mode === 'background' ? ['-o', 'BatchMode=yes'] : []),
        ...SIDE_EFFECT_FREE_OPTIONS,
        '--',
        target.alias,
    ];
}

/** Arguments for asking a running master to report on itself (`check`) or exit. */
export function buildControlArgs(target: SshTarget, operation: 'check' | 'exit'): string[] {
    return ['-O', operation, '-o', `ControlPath=${target.socketPath}`, '--', target.alias];
}

/**
 * Where the socket folder goes: the per-user runtime folder on Linux, which is
 * private and never cleaned up while the user is logged in, else the temp folder
 * (per-user on macOS).
 */
export function getSocketDirBase(): string {
    return process.env.XDG_RUNTIME_DIR || os.tmpdir();
}

/**
 * The private folder control sockets go in. Anyone who can open a socket acts
 * as the signed-in user on the cluster, so the folder must belong to this user
 * and be closed to everyone else; one that is not (or is a symlink) is refused
 * rather than repaired.
 */
export function ensurePrivateSocketDir(baseDir: string = getSocketDirBase()): string {
    const uid = process.getuid?.() ?? 0;
    const dir = path.join(baseDir, `scode-ssh-${uid}`);
    try {
        fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }

    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
        throw new Error(`Refusing to keep SSH connections in ${dir}: it must be a folder only you can access.`);
    }

    return dir;
}

/**
 * Where a host's control socket lives: a short hash of the alias, since aliases
 * may be long or contain characters a file name should not. The folder must not
 * contain anything ssh would read specially in a ControlPath (whitespace ends
 * the value, `%` and a leading `~` are expanded).
 */
export function getSocketPath(alias: string, socketDir: string): string {
    const socketPath = path.join(socketDir, createHash('sha256').update(alias).digest('hex').slice(0, 16));
    if (/[\s%"'\\]/.test(socketPath) || socketPath.startsWith('~')) {
        throw new Error(`The SSH control socket folder has characters ssh cannot take in a path: ${socketDir}`);
    }
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_LENGTH) {
        throw new Error(`The SSH control socket path is too long for this system: ${socketPath}`);
    }

    return socketPath;
}

export type ExecFileRunner = (
    file: string,
    args: string[],
    options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

const execFileRunner: ExecFileRunner = (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, { ...options, env: SSH_ENV, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
            // Same shape as exec's errors, so callers reading stdout/stderr still can
            reject(Object.assign(error, { stdout, stderr }));
        } else {
            resolve({ stdout, stderr });
        }
    });
});

/** Exit status ssh itself uses for its own failures, as opposed to the remote command's. */
export const SSH_FAILURE_EXIT_CODE = 255;

/**
 * Runs Slurm commands on the target over its master. `ssh` is started directly,
 * never through a local shell; the command is only interpreted by the cluster's
 * shell, where `$USER` and the like are meant to expand.
 */
export function createSshCommandRunner(target: SshTarget, run: ExecFileRunner = execFileRunner): SlurmCommandRunner {
    return (command, options) => run('ssh', buildRunArgs(target, buildRemoteCommand(command, options?.cwd?.toString())), {
        maxBuffer: options?.maxBuffer,
        timeout: options?.timeout,
    });
}

/**
 * The pid of the master answering on the target's socket, or undefined when
 * none does. `ssh -O check` reports it as "Master running (pid=4242)".
 */
export async function getMasterPid(target: SshTarget, run: ExecFileRunner = execFileRunner): Promise<number | undefined> {
    try {
        const { stdout, stderr } = await run('ssh', buildControlArgs(target, 'check'), { timeout: 10_000 });
        const match = `${stderr}\n${stdout}`.match(/Master running \(pid=(\d+)\)/);
        return match ? Number(match[1]) : undefined;
    } catch {
        return undefined;
    }
}

/** Whether a master is up and answering on the target's socket. */
export async function isMasterRunning(target: SshTarget, run: ExecFileRunner = execFileRunner): Promise<boolean> {
    return (await getMasterPid(target, run)) !== undefined;
}

/** Asks the target's master to close, which signs this machine out of the host. */
export async function stopMaster(target: SshTarget, run: ExecFileRunner = execFileRunner): Promise<void> {
    try {
        await run('ssh', buildControlArgs(target, 'exit'), { timeout: 10_000 });
    } catch {
        // Already gone
    }
}

/** The `user` line of `ssh -G` output, which is the account ssh logs in as. */
export function parseSshConfigUser(output: string): string | undefined {
    const match = output.match(/^user\s+(\S+)\s*$/m);
    return match?.[1];
}

/**
 * The account ssh logs in to the host as, which is who Slurm knows the user as
 * there. `ssh -G` works it out from the config exactly as a connection would
 * (`User` in the host's block, `Host *`, `Match`, or this machine's login name
 * when nothing sets it) without connecting.
 */
export async function resolveSshUser(alias: string, run: ExecFileRunner = execFileRunner): Promise<string | undefined> {
    try {
        const { stdout } = await run('ssh', ['-G', '--', alias], { timeout: 10_000 });
        return parseSshConfigUser(stdout);
    } catch {
        return undefined;
    }
}

/** Whether something listens on the socket ('live'), it is a leftover nothing answers on ('stale'), or there is none. */
export function probeSocket(socketPath: string): Promise<'live' | 'stale' | 'missing'> {
    return new Promise((resolve) => {
        const socket = net.connect(socketPath);
        socket.once('connect', () => {
            socket.destroy();
            resolve('live');
        });
        socket.once('error', (error: NodeJS.ErrnoException) => {
            resolve(error.code === 'ECONNREFUSED' ? 'stale' : 'missing');
        });
    });
}

/**
 * Removes a socket left behind by a master that died without cleaning up, which
 * would make the next master give up on multiplexing ("already exists"). Only a
 * socket nothing answers on goes: one another window's master is still binding
 * or serving stays put.
 */
export async function removeStaleSocket(target: SshTarget): Promise<void> {
    if (await probeSocket(target.socketPath) === 'stale') {
        try {
            fs.unlinkSync(target.socketPath);
        } catch {
            // Gone meanwhile
        }
    }
}

export type MasterStartResult =
    /** Our master is signed in and serving the socket; `stop` ends it. */
    | { status: 'started'; stop: () => void }
    /** Another master (e.g. another window's) took the socket first; ours was stopped. */
    | { status: 'shared' }
    | { status: 'failed'; stderr: string };

const BACKGROUND_POLL_MS = 250;
// How long to wait for stderr after ssh exits, which a ProxyJump helper may hold open
const STDERR_DRAIN_MS = 500;

/**
 * Starts the master without any prompt (BatchMode), which works when a key or
 * agent is enough. Anything needing the user (a password, 2FA, an unknown host
 * key) fails fast instead, and is left to the terminal sign-in.
 *
 * Success means `ssh -O check` reports this very process as the master: an ssh
 * that signed in but could not take the socket would otherwise sit there signed
 * in with nothing able to reach or stop it, so it is killed instead. The
 * process runs in its own session, so no jump host can prompt on a terminal the
 * editor was started from, and is left running when the extension stops.
 */
export function startMasterInBackground(
    target: SshTarget,
    options: { timeoutMs?: number; isCancelled?: () => boolean } = {},
): Promise<MasterStartResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise((resolve) => {
        let child: ChildProcess;
        try {
            child = spawn('ssh', buildMasterArgs(target, 'background'), {
                detached: true,
                env: SSH_ENV,
                stdio: ['ignore', 'ignore', 'pipe'],
            });
        } catch (error) {
            resolve({ status: 'failed', stderr: (error as Error).message });
            return;
        }

        let stderr = '';
        let settled = false;
        let exited = false;
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });

        const startedAt = Date.now();
        const finish = (result: MasterStartResult) => {
            if (settled) {
                return;
            }
            settled = true;
            if (result.status === 'started') {
                // Ours to keep running: stop listening to it, and let the extension exit without it
                child.stderr?.destroy();
                child.unref();
            } else if (!exited) {
                child.kill();
            }
            resolve(result);
        };

        const stop = () => {
            if (!exited) {
                child.kill();
            }
        };

        // Each check waits for the previous one, so slow checks never pile up
        const poll = async () => {
            if (settled || exited) {
                return;
            }
            if (options.isCancelled?.()) {
                finish({ status: 'failed', stderr: 'Cancelled' });
                return;
            }
            const pid = await getMasterPid(target);
            if (settled || exited) {
                return;
            }
            if (pid === child.pid) {
                finish({ status: 'started', stop });
            } else if (pid !== undefined) {
                finish({ status: 'shared' });
            } else if (Date.now() - startedAt >= timeoutMs) {
                finish({ status: 'failed', stderr: `${stderr}\nTimed out signing in`.trim() });
            } else {
                setTimeout(() => void poll(), BACKGROUND_POLL_MS);
            }
        };
        setTimeout(() => void poll(), BACKGROUND_POLL_MS);

        const settleOnExit = () => finish({ status: 'failed', stderr: stderr.trim() || 'ssh exited' });
        child.on('exit', () => {
            exited = true;
            // Wait for stderr to drain, which says why, but not forever
            setTimeout(settleOnExit, STDERR_DRAIN_MS);
        });
        child.on('close', settleOnExit);
        child.on('error', (error) => {
            exited = true;
            finish({ status: 'failed', stderr: error.message });
        });
    });
}
