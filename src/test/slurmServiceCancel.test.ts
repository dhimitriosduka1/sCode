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
});
