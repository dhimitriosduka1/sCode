import { execFile, ExecFileOptions } from 'child_process';
import { ensureDefaultSshControlDirectory, getDefaultSshControlOptions } from './sshConfig';

export interface SlurmCommandResult {
    stdout: string;
    stderr: string;
}

export interface SlurmCommandInvocation {
    command: string;
    args?: string[];
    cwd?: string;
    maxBuffer?: number;
}

export interface SlurmExecutor {
    readonly kind: 'local' | 'ssh';
    readonly connectionKey: string;
    run(invocation: SlurmCommandInvocation): Promise<SlurmCommandResult>;
}

export type ExecFileRunner = (
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
) => Promise<SlurmCommandResult>;

export const ALLOWED_SLURM_COMMANDS = new Set([
    'id',
    'squeue',
    'scontrol',
    'sinfo',
    'sacct',
    'sbatch',
    'scancel',
    'nvidia-smi',
    'stat',
    'cat',
]);

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const SSH_TRANSIENT_RETRY_DELAYS_MS = [250, 750];

const defaultExecFileRunner: ExecFileRunner = (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
        const result = {
            stdout: stdout?.toString() ?? '',
            stderr: stderr?.toString() ?? '',
        };

        if (error) {
            const enrichedError = error as Error & Partial<SlurmCommandResult>;
            enrichedError.stdout = result.stdout;
            enrichedError.stderr = result.stderr;
            reject(enrichedError);
            return;
        }

        resolve(result);
    });
});

type ExecutorError = Error & Partial<SlurmCommandResult> & {
    code?: string;
};

function cloneExecutorError(message: string, source: unknown): ExecutorError {
    const error = new Error(message) as ExecutorError;
    if (source instanceof Error) {
        error.stack = source.stack;
    }

    const sourceError = source as Partial<ExecutorError>;
    error.stdout = sourceError.stdout ?? '';
    error.stderr = sourceError.stderr ?? '';
    error.code = sourceError.code;
    return error;
}

export function isTransientSshStartupError(error: unknown): boolean {
    const executorError = error as Partial<ExecutorError>;
    const text = [
        executorError.stderr,
        executorError.stdout,
        error instanceof Error ? error.message : String(error),
    ].filter(Boolean).join('\n');

    return /kex_exchange_identification/i.test(text) ||
        /connection closed by remote host/i.test(text) ||
        /connection closed by .* port 22/i.test(text) ||
        /connection reset by peer/i.test(text) ||
        /banner exchange/i.test(text) ||
        /mux_client_request_session.*(?:read from master failed|connection failed)/i.test(text) ||
        /control socket connect.*no such file/i.test(text);
}

function normalizeExecutorError(error: unknown, executable: string, requestedCommand: string, kind: SlurmExecutor['kind']): Error {
    const executorError = error as Partial<ExecutorError>;
    const stderr = executorError.stderr?.trim() ?? '';

    if (executorError.code === 'ENOENT') {
        if (executable === 'ssh') {
            return cloneExecutorError(
                'OpenSSH client not found: ssh. Install OpenSSH or switch SLURM Cluster Manager to Local connection mode.',
                error
            );
        }

        if (kind === 'local') {
            return cloneExecutorError(
                `Local Slurm command not found: ${requestedCommand}. Install the Slurm CLI locally or switch SLURM Cluster Manager to SSH connection mode.`,
                error
            );
        }
    }

    if (kind === 'ssh' && stderr && /permission denied/i.test(stderr)) {
        return cloneExecutorError(
            `SSH authentication failed. SLURM Cluster Manager uses non-interactive OpenSSH with BatchMode=yes for background commands, so password prompts are not supported there. Use "SLURM: Start 2FA SSH Login" or the copied SSH test command to authenticate once in a terminal, then retry. Details: ${stderr}`,
            error
        );
    }

    if (kind === 'ssh' && stderr && /(host key verification failed|remote host identification has changed|authenticity of host)/i.test(stderr)) {
        return cloneExecutorError(
            `SSH host-key verification failed or requires confirmation. SLURM Cluster Manager keeps OpenSSH host-key checking enabled. Connect once from a terminal with "ssh <host> id -un", verify the host key, and retry. Details: ${stderr}`,
            error
        );
    }

    if (kind === 'ssh' && stderr && /\b(command not found|not found)\b/i.test(stderr)) {
        return cloneExecutorError(
            `Remote Slurm command not found: ${requestedCommand}. Make sure Slurm commands are available on the remote host PATH for non-interactive SSH sessions. Details: ${stderr}`,
            error
        );
    }

    if (kind === 'ssh' && isTransientSshStartupError(error)) {
        const details = stderr || (error instanceof Error ? error.message : String(error));
        return cloneExecutorError(
            `SSH connection was closed by the remote host during startup. SLURM Cluster Manager retried automatically, but the connection still failed. This is often caused by login-node connection limits or an expired SSH ControlMaster session. Try again, or start a fresh SSH login session if it persists. Details: ${details}`,
            error
        );
    }

    return error instanceof Error ? error : new Error(String(error));
}

export function validateSlurmCommand(command: string): void {
    if (!ALLOWED_SLURM_COMMANDS.has(command)) {
        throw new Error(`Unsupported command: ${command}`);
    }
}

export function validateShellArg(value: string, label: string = 'argument'): void {
    if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
        throw new Error(`Unsafe ${label}: contains a control character`);
    }
}

export function validateRemoteFilePath(filePath: string): void {
    validateShellArg(filePath, 'remote path');
    if (!filePath.startsWith('/')) {
        throw new Error('Remote file path must be absolute');
    }
}

export function validateJobId(jobId: string): void {
    validateShellArg(jobId, 'job ID');
    if (!/^\d+(?:_(?:\d+|\[(?:\d+(?:-\d+)?(?::\d+)?)(?:,\d+(?:-\d+)?(?::\d+)?)*(?:%\d+)?\]))?$/.test(jobId)) {
        throw new Error(`Unsafe job ID: ${jobId}`);
    }
}

export function validateJobState(state: string): void {
    validateShellArg(state, 'job state');
    if (!/^[A-Z_]+$/.test(state)) {
        throw new Error(`Unsafe job state: ${state}`);
    }
}

export function validatePartitionName(partition: string): void {
    validateShellArg(partition, 'partition name');
    if (!/^[A-Za-z0-9_.+-]+$/.test(partition)) {
        throw new Error(`Unsafe partition name: ${partition}`);
    }
}

export function posixShellQuote(value: string): string {
    validateShellArg(value);
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeTimeoutSeconds(timeoutSeconds: number): number {
    if (!Number.isFinite(timeoutSeconds)) {
        return 10;
    }

    return Math.min(120, Math.max(1, Math.round(timeoutSeconds)));
}

function normalizeMaxBuffer(maxBuffer: number | undefined): number {
    if (!maxBuffer || !Number.isFinite(maxBuffer)) {
        return DEFAULT_MAX_BUFFER;
    }

    return Math.max(1024, Math.floor(maxBuffer));
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function validateInvocation(invocation: SlurmCommandInvocation): { command: string; args: string[] } {
    validateSlurmCommand(invocation.command);
    const args = invocation.args ?? [];

    for (const arg of args) {
        validateShellArg(arg);
    }

    if (invocation.cwd) {
        validateShellArg(invocation.cwd, 'working directory');
    }

    return {
        command: invocation.command,
        args,
    };
}

export class LocalSlurmExecutor implements SlurmExecutor {
    readonly kind = 'local' as const;
    readonly connectionKey = 'local';

    constructor(private readonly execFileRunner: ExecFileRunner = defaultExecFileRunner) {}

    async run(invocation: SlurmCommandInvocation): Promise<SlurmCommandResult> {
        const { command, args } = validateInvocation(invocation);
        try {
            return await this.execFileRunner(command, args, {
                cwd: invocation.cwd,
                maxBuffer: normalizeMaxBuffer(invocation.maxBuffer),
            });
        } catch (error) {
            throw normalizeExecutorError(error, command, command, this.kind);
        }
    }
}

export interface SshSlurmExecutorOptions {
    host: string;
    connectTimeoutSeconds?: number;
    execFileRunner?: ExecFileRunner;
    prepareControlDirectory?: () => void;
    retryDelayMs?: (retryIndex: number) => number;
}

export class SshSlurmExecutor implements SlurmExecutor {
    readonly kind = 'ssh' as const;
    readonly connectionKey: string;

    private readonly host: string;
    private readonly connectTimeoutSeconds: number;
    private readonly execFileRunner: ExecFileRunner;
    private readonly prepareControlDirectory: () => void;
    private readonly retryDelayMs: (retryIndex: number) => number;
    private runQueue: Promise<void> = Promise.resolve();

    constructor(options: SshSlurmExecutorOptions) {
        this.host = options.host.trim();
        this.connectTimeoutSeconds = normalizeTimeoutSeconds(options.connectTimeoutSeconds ?? 10);
        this.execFileRunner = options.execFileRunner ?? defaultExecFileRunner;
        this.prepareControlDirectory = options.prepareControlDirectory ?? ensureDefaultSshControlDirectory;
        this.retryDelayMs = options.retryDelayMs ?? ((retryIndex: number) => SSH_TRANSIENT_RETRY_DELAYS_MS[retryIndex] ?? 0);
        this.connectionKey = `ssh:${this.host}`;
    }

    async run(invocation: SlurmCommandInvocation): Promise<SlurmCommandResult> {
        const previousRun = this.runQueue;
        let releaseRun = () => {};
        this.runQueue = new Promise<void>(resolve => {
            releaseRun = resolve;
        });

        await previousRun;
        try {
            return await this.runWithTransientRetry(invocation);
        } finally {
            releaseRun();
        }
    }

    private async runWithTransientRetry(invocation: SlurmCommandInvocation): Promise<SlurmCommandResult> {
        const maxAttempts = SSH_TRANSIENT_RETRY_DELAYS_MS.length + 1;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                return await this.runOnce(invocation);
            } catch (error) {
                if (!isTransientSshStartupError(error) || attempt === maxAttempts - 1) {
                    throw normalizeExecutorError(error, 'ssh', invocation.command, this.kind);
                }

                const delayMs = Math.max(0, this.retryDelayMs(attempt));
                if (delayMs > 0) {
                    await sleep(delayMs);
                }
            }
        }

        throw new Error('Unreachable SSH retry state');
    }

    private async runOnce(invocation: SlurmCommandInvocation): Promise<SlurmCommandResult> {
        this.validateHost();
        this.prepareControlDirectory();
        const remoteCommand = this.buildRemoteCommand(invocation);
        const args = [
            '-o',
            'BatchMode=yes',
            '-o',
            `ConnectTimeout=${this.connectTimeoutSeconds}`,
            ...getDefaultSshControlOptions().flatMap(option => ['-o', option]),
            this.host,
            remoteCommand,
        ];

        try {
            return await this.execFileRunner('ssh', args, {
                maxBuffer: normalizeMaxBuffer(invocation.maxBuffer),
            });
        } catch (error) {
            throw normalizeExecutorError(error, 'ssh', invocation.command, this.kind);
        }
    }

    buildRemoteCommand(invocation: SlurmCommandInvocation): string {
        const { command, args } = validateInvocation(invocation);
        const serializedCommand = [
            command,
            ...args.map(posixShellQuote),
        ].join(' ');

        if (!invocation.cwd) {
            return serializedCommand;
        }

        validateRemoteFilePath(invocation.cwd);
        return `cd ${posixShellQuote(invocation.cwd)} && ${serializedCommand}`;
    }

    private validateHost(): void {
        validateShellArg(this.host, 'SSH host');
        if (!this.host || this.host.startsWith('-') || /\s/.test(this.host)) {
            throw new Error('SSH host must be a configured host alias or user@host value');
        }
    }
}
