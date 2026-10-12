import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmCommandRunner, SlurmService } from '../slurmService';

describe('SlurmService cancellation commands', () => {
    it('cancels all pending jobs for the current user', async () => {
        const commands: string[] = [];
        const commandRunner: SlurmCommandRunner = async (argv) => {
            commands.push(argv.join(' '));
            return { stdout: argv[0] === 'id' ? 'alice\n' : '', stderr: '' };
        };
        const service = new SlurmService(undefined, undefined, commandRunner);

        const result = await service.cancelAllPendingJobs();

        assert.deepEqual(commands, ['id -un', 'scancel --state=PENDING -u alice']);
        assert.deepEqual(result, {
            success: true,
            message: 'All pending jobs cancelled successfully',
        });
    });

    it('reports failures when pending job cancellation fails', async () => {
        const commands: string[] = [];
        const commandRunner: SlurmCommandRunner = async (argv) => {
            commands.push(argv.join(' '));
            if (argv[0] === 'id') {
                return { stdout: 'alice\n', stderr: '' };
            }
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

        assert.deepEqual(commands, ['id -un', 'scancel --state=PENDING -u alice']);
        assert.deepEqual(result, {
            success: false,
            message: 'Failed to cancel pending jobs: scheduler refused request',
        });
    });
});
