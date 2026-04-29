import { execFile, ExecFileOptions } from 'child_process';

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
            `SSH authentication failed. SLURM Cluster Manager uses non-interactive OpenSSH with BatchMode=yes, so password prompts are not supported. Configure an SSH key/agent or a valid Kerberos/GSSAPI ticket for this host, then verify that "ssh <host> id -un" works without prompting. Details: ${stderr}`,
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
}

export class SshSlurmExecutor implements SlurmExecutor {
    readonly kind = 'ssh' as const;
    readonly connectionKey: string;

    private readonly host: string;
    private readonly connectTimeoutSeconds: number;
    private readonly execFileRunner: ExecFileRunner;

    constructor(options: SshSlurmExecutorOptions) {
        this.host = options.host.trim();
        this.connectTimeoutSeconds = normalizeTimeoutSeconds(options.connectTimeoutSeconds ?? 10);
        this.execFileRunner = options.execFileRunner ?? defaultExecFileRunner;
        this.connectionKey = `ssh:${this.host}`;
    }

    async run(invocation: SlurmCommandInvocation): Promise<SlurmCommandResult> {
        this.validateHost();
        const remoteCommand = this.buildRemoteCommand(invocation);
        const args = [
            '-o',
            'BatchMode=yes',
            '-o',
            `ConnectTimeout=${this.connectTimeoutSeconds}`,
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
