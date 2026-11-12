import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmCommandRunner, SlurmService } from '../slurmService';

describe('SlurmService cancellation commands', () => {
    it('cancels all pending jobs for the current user', async () => {
        const commands: string[] = [];
        const commandRunner: SlurmCommandRunner = async (command) => {
            commands.push(command);
            return { stdout: '', stderr: '' };
        };
        const service = new SlurmService(undefined, undefined, commandRunner);

        const result = await service.cancelAllPendingJobs();

        assert.deepEqual(commands, ['scancel --state=PENDING -u $USER']);
        assert.deepEqual(result, {
            success: true,
            message: 'All pending jobs cancelled successfully',
        });
    });

    it('reports failures when pending job cancellation fails', async () => {
        const commands: string[] = [];
        const commandRunner: SlurmCommandRunner = async (command) => {
            commands.push(command);
            throw new Error('scheduler refused request');
        };
        const service = new SlurmService(undefined, undefined, commandRunner);

        const originalConsoleError = console.error;
        console.error = () => undefined;
        let result;
        try {
            result = await service.cancelAllPendingJobs();
        } finally {
            console.error = originalConsoleError;
        }

        assert.deepEqual(commands, ['scancel --state=PENDING -u $USER']);
        assert.deepEqual(result, {
            success: false,
            message: 'Failed to cancel pending jobs: scheduler refused request',
        });
    });

    // A job's dependents can be arrays with tasks already running, which must
    // keep running: scancel's state filter leaves them alone. One scancel, as
    // each would take its own session on a shared SSH connection.
    it('cancels only the pending part of the given jobs, in one scancel', async () => {
        const commands: string[] = [];
        const commandRunner: SlurmCommandRunner = async (command) => {
            commands.push(command);
            return { stdout: '', stderr: '' };
        };
        const service = new SlurmService(undefined, undefined, commandRunner);

        const result = await service.cancelPendingJobs(['456', '789']);

        assert.deepEqual(commands, ["scancel --state=PENDING '456' '789'"]);
        assert.deepEqual(result, {
            success: true,
            message: 'Pending jobs in 456, 789 cancelled successfully',
        });
    });

    it('reports failures when cancelling the pending part of jobs fails', async () => {
        const commandRunner: SlurmCommandRunner = async () => {
            throw new Error('Invalid job id specified');
        };
        const service = new SlurmService(undefined, undefined, commandRunner);

        const originalConsoleError = console.error;
        console.error = () => undefined;
        let result;
        try {
            result = await service.cancelPendingJobs(['456', '789']);
        } finally {
            console.error = originalConsoleError;
        }

        assert.deepEqual(result, {
            success: false,
            message: 'Failed to cancel pending jobs in 456, 789: Invalid job id specified',
        });
    });
});
