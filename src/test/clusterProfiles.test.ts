import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    inferClusterNameFromHost,
    mergeClusterProfiles,
    normalizeClusterProfiles,
    resolveActiveClusterProfile,
    upsertClusterProfile,
    validateClusterName,
    validateSshHost,
} from '../clusterProfiles';

describe('cluster profiles', () => {
    it('resolves the active named SSH cluster before legacy settings', () => {
        const profile = resolveActiveClusterProfile({
            activeCluster: 'GPU-B',
            connectionMode: 'ssh',
            sshHost: 'legacy-host',
            clusters: [
                { name: 'gpu-a', connectionMode: 'ssh', sshHost: 'login-a' },
                { name: 'gpu-b', connectionMode: 'ssh', sshHost: 'login-b', sshConnectTimeout: 42 },
            ],
        });

        assert.deepEqual(profile, {
            name: 'gpu-b',
            connectionMode: 'ssh',
            sshHost: 'login-b',
            sshConnectTimeout: 42,
            remoteLogMaxBytes: 2097152,
        });
    });

    it('falls back to legacy single-cluster SSH settings', () => {
        const profile = resolveActiveClusterProfile({
            connectionMode: 'ssh',
            sshHost: 'user@login.example.edu',
            sshConnectTimeout: 8,
        });

        assert.deepEqual(profile, {
            name: 'login',
            connectionMode: 'ssh',
            sshHost: 'user@login.example.edu',
            sshConnectTimeout: 8,
            remoteLogMaxBytes: 2097152,
        });
    });

    it('supports explicit local mode through activeCluster', () => {
        assert.deepEqual(resolveActiveClusterProfile({
            activeCluster: 'Local',
            connectionMode: 'ssh',
            sshHost: 'login',
        }), {
            name: 'local',
            connectionMode: 'local',
        });
    });

    it('normalizes cluster arrays and ignores invalid profiles', () => {
        assert.deepEqual(normalizeClusterProfiles([
            { name: 'gpu-a', connectionMode: 'ssh', sshHost: 'login-a' },
            { name: 'gpu-a', connectionMode: 'ssh', sshHost: 'duplicate' },
            { name: 'missing-host', connectionMode: 'ssh' },
            { name: 'local', connectionMode: 'local' },
            { name: 'Local', connectionMode: 'ssh', sshHost: 'would-collide' },
            { name: 'local-profile', connectionMode: 'local' },
            { name: 'bad-host', connectionMode: 'ssh', sshHost: 'bad host' },
            null,
        ]), [
            {
                name: 'gpu-a',
                connectionMode: 'ssh',
                sshHost: 'login-a',
                sshConnectTimeout: 10,
                remoteLogMaxBytes: 2097152,
            },
            {
                name: 'local-profile',
                connectionMode: 'local',
            },
        ]);
    });

    it('upserts profiles by name and validates unsafe values', () => {
        const profiles = upsertClusterProfile([
            { name: 'gpu-a', connectionMode: 'ssh', sshHost: 'old-login' },
        ], {
            name: 'gpu-a',
            connectionMode: 'ssh',
            sshHost: 'new-login',
        });

        assert.equal(profiles.length, 1);
        assert.equal(profiles[0].sshHost, 'new-login');
        assert.throws(() => validateSshHost('-bad'), /host alias/);
        assert.throws(() => validateSshHost('bad host'), /without whitespace/);
        assert.throws(() => validateClusterName('local'), /reserved/);
        assert.throws(() => validateClusterName('Local'), /reserved/);
    });

    it('infers stable cluster names from SSH hosts', () => {
        assert.equal(inferClusterNameFromHost('user@gpu-login.example.edu'), 'gpu-login');
        assert.equal(inferClusterNameFromHost('cluster alias'), 'cluster-alias');
    });

    it('lets stored profiles override same-named settings profiles', () => {
        const merged = mergeClusterProfiles(
            normalizeClusterProfiles([
                { name: 'gpu-a', connectionMode: 'ssh', sshHost: 'settings-login' },
                { name: 'gpu-b', connectionMode: 'ssh', sshHost: 'settings-b' },
            ]),
            normalizeClusterProfiles([
                { name: 'GPU-A', connectionMode: 'ssh', sshHost: 'stored-login', sshConnectTimeout: 17 },
            ])
        );

        assert.deepEqual(merged, [
            {
                name: 'GPU-A',
                connectionMode: 'ssh',
                sshHost: 'stored-login',
                sshConnectTimeout: 17,
                remoteLogMaxBytes: 2097152,
            },
            {
                name: 'gpu-b',
                connectionMode: 'ssh',
                sshHost: 'settings-b',
                sshConnectTimeout: 10,
                remoteLogMaxBytes: 2097152,
            },
        ]);
    });

    it('falls back to local when an active cluster points at an invalid profile', () => {
        assert.deepEqual(resolveActiveClusterProfile({
            activeCluster: 'bad',
            clusters: [{ name: 'bad', connectionMode: 'ssh', sshHost: 'bad host' }],
            connectionMode: 'local',
        }), {
            name: 'local',
            connectionMode: 'local',
        });
    });
});
