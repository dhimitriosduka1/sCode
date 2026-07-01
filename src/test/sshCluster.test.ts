import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { createSSHCommandRunner } from '../sshCommandRunner';
import { buildSSHArgs } from '../sshFileTransfer';

describe('SSH Command Runner Tests', () => {
    it('correctly builds command with working directory', async () => {
        const commandsRun: string[] = [];
        const mockSession: any = {
            execute: async (cmd: string) => {
                commandsRun.push(cmd);
                return { stdout: 'success', stderr: '', exitCode: 0 };
            }
        };

        const runner = createSSHCommandRunner(mockSession);
        const result = await runner('squeue', { cwd: '/scratch/job_dir' });

        assert.equal(result.stdout, 'success');
        assert.deepEqual(commandsRun, ['cd "/scratch/job_dir" && squeue']);
    });

    it('throws error on non-zero exit code unless ignored', async () => {
        const mockSession: any = {
            execute: async (cmd: string) => {
                return { stdout: '', stderr: 'command not found', exitCode: 127 };
            }
        };

        const runner = createSSHCommandRunner(mockSession);

        // Should throw on normal failure
        await assert.rejects(
            async () => {
                await runner('squeue');
            },
            /Command failed:/
        );

        // Should NOT throw if 2>/dev/null is present
        const result = await runner('which squeue 2>/dev/null');
        assert.equal(result.stdout, '');
    });
});

describe('SSH File Transfer Argument Builder', () => {
    it('builds host destination argument list', () => {
        const profile = {
            name: 'Cluster A',
            host: 'cluster.edu',
            username: 'jdoe',
            port: 2222,
            identityFile: '/keys/id_rsa'
        };

        const args = buildSSHArgs(profile);
        assert.deepEqual(args, ['-p', '2222', '-i', '/keys/id_rsa', 'jdoe@cluster.edu']);
    });

    it('builds minimal argument list when user/port/keys are omitted', () => {
        const profile = {
            name: 'Cluster B',
            host: 'cluster.org'
        };

        const args = buildSSHArgs(profile);
        assert.deepEqual(args, ['cluster.org']);
    });
});
