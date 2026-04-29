import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmService } from '../slurmService';
import { SlurmCommandInvocation, SlurmExecutor } from '../slurmExecutor';

describe('SlurmService cancellation commands', () => {
    it('cancels all pending jobs for the current user', async () => {
        const commands: SlurmCommandInvocation[] = [];
        const executor: SlurmExecutor = {
            kind: 'local',
            connectionKey: 'local',
            async run(invocation) {
                commands.push(invocation);
                if (invocation.command === 'id') {
                    return { stdout: 'test-user\n', stderr: '' };
                }
                return { stdout: '', stderr: '' };
            },
        };
        const service = new SlurmService(undefined, undefined, executor);

        const result = await service.cancelAllPendingJobs();

        assert.deepEqual(commands, [
            { command: 'id', args: ['-un'] },
            { command: 'scancel', args: ['--state=PENDING', '-u', 'test-user'] },
        ]);
        assert.deepEqual(result, {
            success: true,
            message: 'All pending jobs cancelled successfully',
        });
    });

    it('cancels a selected job with structured arguments', async () => {
        const commands: SlurmCommandInvocation[] = [];
        const executor: SlurmExecutor = {
            kind: 'local',
            connectionKey: 'local',
            async run(invocation) {
                commands.push(invocation);
                return { stdout: '', stderr: '' };
            },
        };
        const service = new SlurmService(undefined, undefined, executor);

        const result = await service.cancelJob('123_[1,3]');

        assert.deepEqual(commands, [
            { command: 'scancel', args: ['123_[1,3]'] },
        ]);
        assert.deepEqual(result, {
            success: true,
            message: 'Job 123_[1,3] cancelled successfully',
        });
    });

    it('reports failures when pending job cancellation fails', async () => {
        const commands: SlurmCommandInvocation[] = [];
        const executor: SlurmExecutor = {
            kind: 'local',
            connectionKey: 'local',
            async run(invocation) {
                commands.push(invocation);
                if (invocation.command === 'id') {
                    return { stdout: 'test-user\n', stderr: '' };
                }
                throw new Error('scheduler refused request');
            },
        };
        const service = new SlurmService(undefined, undefined, executor);

        const originalConsoleError = console.error;
        console.error = () => undefined;
        let result;
        try {
            result = await service.cancelAllPendingJobs();
        } finally {
            console.error = originalConsoleError;
        }

        assert.deepEqual(commands, [
            { command: 'id', args: ['-un'] },
            { command: 'scancel', args: ['--state=PENDING', '-u', 'test-user'] },
        ]);
        assert.deepEqual(result, {
            success: false,
            message: 'Failed to cancel pending jobs: scheduler refused request',
        });
    });

    it('rejects unsafe job IDs before executing cancellation', async () => {
        const commands: SlurmCommandInvocation[] = [];
        const executor: SlurmExecutor = {
            kind: 'local',
            connectionKey: 'local',
            async run(invocation) {
                commands.push(invocation);
                return { stdout: '', stderr: '' };
            },
        };
        const service = new SlurmService(undefined, undefined, executor);

        const originalConsoleError = console.error;
        console.error = () => undefined;
        let result;
        try {
            result = await service.cancelJob('123;rm -rf /');
        } finally {
            console.error = originalConsoleError;
        }

        assert.deepEqual(commands, []);
        assert.deepEqual(result, {
            success: false,
            message: 'Failed to cancel job 123;rm -rf /: Unsafe job ID: 123;rm -rf /',
        });
    });
});
