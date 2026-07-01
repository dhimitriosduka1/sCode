import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { SSHSession } from './sshSession';
import { SlurmCommandRunner } from './slurmService';

const execAsync = promisify(exec);

/**
 * Creates a SlurmCommandRunner that routes commands through an active SSHSession
 */
export function createSSHCommandRunner(session: SSHSession): SlurmCommandRunner {
    const runner: SlurmCommandRunner = async (command: string, options?: ExecOptions) => {
        let finalCommand = command;
        
        // Handle working directory by changing directory on the remote machine
        if (options?.cwd) {
            finalCommand = `cd "${options.cwd}" && ${command}`;
        }

        const result = await session.execute(finalCommand);

        // Mimic child_process exec behavior by throwing on non-zero exit codes.
        // Ignore errors if the command explicitly discards stderr (like `2>/dev/null`).
        if (result.exitCode !== 0 && !command.includes('2>/dev/null')) {
            const error = new Error(`Command failed: ${finalCommand}\n${result.stderr || result.stdout}`);
            (error as any).code = result.exitCode;
            (error as any).stdout = result.stdout;
            (error as any).stderr = result.stderr;
            throw error;
        }

        return {
            stdout: result.stdout,
            stderr: result.stderr,
        };
    };

    // Attach batchExecute helper to command runner function
    (runner as any).batchExecute = async (commands: string[]) => {
        const results = await session.batchExecute(commands);
        return results.map(res => {
            return { stdout: res.stdout, stderr: res.stderr };
        });
    };

    return runner;
}

/**
 * Creates a standard local SlurmCommandRunner
 */
export function createLocalCommandRunner(): SlurmCommandRunner {
    const runner: SlurmCommandRunner = async (command: string, options?: ExecOptions) => {
        const { stdout, stderr } = await execAsync(command, options);
        return {
            stdout: stdout.toString(),
            stderr: stderr.toString(),
        };
    };

    // Attach local sequential batch execution
    (runner as any).batchExecute = async (commands: string[]) => {
        return Promise.all(
            commands.map(cmd => runner(cmd))
        );
    };

    return runner;
}
