import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    formatSshBatchModeTestCommand,
    formatSshControlMasterExitCommand,
    formatSshInteractiveLoginCommand,
    getDefaultSshControlOptions,
    isInteractiveSshAuthFailure,
    parseSshConfigHosts,
    resolveDefaultSshControlPath,
    supportsSshControlMaster,
} from '../sshConfig';

describe('SSH config helpers', () => {
    it('parses selectable host aliases from OpenSSH config content', () => {
        assert.deepEqual(parseSshConfigHosts(`
Host dais raven
    HostName dais11.mpcdf.mpg.de

Host *.mpcdf.mpg.de
    User dduka

Host !blocked login-gpu # trailing comment
Host *
    ServerAliveInterval 30
`), [
            'dais',
            'raven',
            'login-gpu',
        ]);
    });

    it('deduplicates aliases case-insensitively while preserving display casing', () => {
        assert.deepEqual(parseSshConfigHosts(`
Host Dais
Host dais DAIS2
`), [
            'Dais',
            'DAIS2',
        ]);
    });

    it('formats the exact non-interactive SSH test command', () => {
        const command = formatSshBatchModeTestCommand('dais', {
            platform: 'linux',
            env: { XDG_RUNTIME_DIR: '/run/user/1000' },
            homeDir: '/home/alice',
            tmpDir: '/tmp',
            uid: 1000,
        });

        assert.match(command, /^ssh /);
        assert.match(command, /-o BatchMode=yes dais id -un$/);
        assert.match(command, /-o ControlMaster=auto/);
        assert.match(command, /-o ControlPersist=8h/);
        assert.match(command, /-o .*cm-%C/);
        assert.match(command, /-o ServerAliveInterval=60/);
    });

    it('formats an interactive SSH login command without exposing shell metacharacters', () => {
        const input = {
            platform: 'linux' as NodeJS.Platform,
            env: { XDG_RUNTIME_DIR: '/run/user/1000' },
            homeDir: '/home/alice',
            tmpDir: '/tmp',
            uid: 1000,
        };
        assert.match(formatSshInteractiveLoginCommand('dais', input), /^ssh .* dais true$/);
        assert.match(
            formatSshInteractiveLoginCommand("login'host", input),
            /ssh .* 'login'\\''host' true$/,
        );
    });

    it('formats the OpenSSH ControlMaster exit command', () => {
        const input = {
            platform: 'linux' as NodeJS.Platform,
            env: { XDG_RUNTIME_DIR: '/run/user/1000' },
            homeDir: '/home/alice',
            tmpDir: '/tmp',
            uid: 1000,
        };
        assert.match(formatSshControlMasterExitCommand('dais', input), /^ssh .* -O exit dais$/);
        assert.match(
            formatSshControlMasterExitCommand("login'host", input),
            /^ssh .* -O exit 'login'\\''host'$/,
        );
    });

    it('uses stable OpenSSH control options for reusable 2FA sessions', () => {
        const options = getDefaultSshControlOptions({
            platform: 'linux',
            env: { XDG_RUNTIME_DIR: '/run/user/1000' },
            homeDir: '/home/alice',
            tmpDir: '/tmp',
            uid: 1000,
        });

        assert.deepEqual(options.filter(option =>
            option === 'ControlMaster=auto' ||
            option === 'ControlPersist=8h' ||
            option === 'ServerAliveInterval=60'
        ), [
            'ControlMaster=auto',
            'ControlPersist=8h',
            'ServerAliveInterval=60',
        ]);
        assert.ok(options.some(option =>
            option.startsWith('ControlPath=') && option.includes('cm-%C')
        ));
    });

    it('uses a Linux runtime directory for control sockets when available', () => {
        assert.equal(
            resolveDefaultSshControlPath({
                platform: 'linux',
                env: { XDG_RUNTIME_DIR: '/run/user/1000' },
                homeDir: '/home/alice',
                tmpDir: '/tmp',
                uid: 1000,
            }),
            '/run/user/1000/slurm-cluster-manager/cm-%C',
        );
    });

    it('falls back to a user-specific temp directory on Linux without XDG_RUNTIME_DIR', () => {
        assert.equal(
            resolveDefaultSshControlPath({
                platform: 'linux',
                env: {},
                homeDir: '/home/alice',
                tmpDir: '/tmp',
                uid: 1000,
            }),
            '/tmp/slurm-cluster-manager-1000/cm-%C',
        );
    });

    it('keeps the short ~/.ssh control path on non-Linux platforms', () => {
        assert.equal(
            resolveDefaultSshControlPath({
                platform: 'darwin',
                env: { XDG_RUNTIME_DIR: '/run/user/1000' },
                homeDir: '/Users/alice',
                tmpDir: '/tmp',
                uid: 501,
            }),
            '/Users/alice/.ssh/cm-%C',
        );
    });

    it('does not use ControlMaster options on Windows OpenSSH', () => {
        assert.equal(supportsSshControlMaster('win32'), false);
        assert.deepEqual(getDefaultSshControlOptions({ platform: 'win32' }), [
            'ServerAliveInterval=60',
        ]);

        const command = formatSshBatchModeTestCommand('dais', { platform: 'win32' });
        assert.match(command, /^ssh /);
        assert.doesNotMatch(command, /ControlMaster/);
        assert.doesNotMatch(command, /ControlPath/);
        assert.match(command, /-o ServerAliveInterval=60 -o BatchMode=yes dais id -un$/);
        assert.throws(
            () => formatSshControlMasterExitCommand('dais', { platform: 'win32' }),
            /ControlMaster is not supported/
        );
    });

    it('detects interactive SSH authentication failures', () => {
        assert.equal(
            isInteractiveSshAuthFailure('SSH authentication failed. BatchMode=yes means password prompts are not supported.'),
            true,
        );
        assert.equal(
            isInteractiveSshAuthFailure('dduka@host: Permission denied (gssapi-with-mic,password).'),
            true,
        );
        assert.equal(
            isInteractiveSshAuthFailure('Remote Slurm command not found: squeue'),
            false,
        );
    });
});
