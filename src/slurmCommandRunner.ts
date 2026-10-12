import { execFile } from 'child_process';
import { Writable } from 'stream';

export interface SlurmCommandOptions {
    maxBuffer?: number;
    /** Directory to run in; when commands run over SSH, a directory on the cluster */
    cwd?: string;
    /** Written to the command's standard input, as sbatch reads a script from there */
    input?: string;
}

export interface SlurmCommandResult {
    stdout: string;
    stderr: string;
}

/**
 * Runs one program with its arguments. Arguments are passed as a list and
 * never through a local shell, so values like job IDs and partition names
 * can't be read as shell syntax.
 */
export type SlurmCommandRunner = (argv: readonly string[], options?: SlurmCommandOptions) => Promise<SlurmCommandResult>;

/** Runs commands on this machine, as on a login node or in a Remote - SSH window. */
export const localCommandRunner: SlurmCommandRunner = (argv, options) => new Promise((resolve, reject) => {
    const [program, ...args] = argv;
    const child = execFile(
        program,
        args,
        { maxBuffer: options?.maxBuffer, cwd: options?.cwd, encoding: 'utf8' },
        (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }),
    );
    writeInput(child.stdin, options?.input);
});

/**
 * Sends a command its input, then closes its standard input, so a command
 * that reads it gets the end of input rather than waiting forever.
 */
export function writeInput(stdin: Writable | null, input: string | undefined): void {
    // A command that exits before reading its input closes the pipe; that's not an error here
    stdin?.on('error', () => undefined);
    stdin?.end(input ?? '');
}

/** Thrown when commands run on a cluster over SSH and there is no connection to it. */
export class SlurmNotConnectedError extends Error {
    constructor(readonly host: string) {
        super(`Not connected to ${host}`);
        this.name = 'SlurmNotConnectedError';
    }
}
