import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    createRemoteSlurmQuery,
    getRemoteSlurmConnectionMismatch,
    parseRemoteSlurmConnectionKey,
} from '../remoteSlurmUri';

describe('remote Slurm document URIs', () => {
    it('round-trips connection keys through a URI query', () => {
        const query = createRemoteSlurmQuery('ssh:user@login.example.edu');

        assert.equal(query, 'connection=ssh%3Auser%40login.example.edu');
        assert.equal(parseRemoteSlurmConnectionKey(query ?? ''), 'ssh:user@login.example.edu');
    });

    it('detects remote documents from a different active cluster', () => {
        assert.equal(
            getRemoteSlurmConnectionMismatch('ssh:cluster-a', 'ssh:cluster-a'),
            undefined,
        );
        assert.match(
            getRemoteSlurmConnectionMismatch('ssh:cluster-a', 'ssh:cluster-b') ?? '',
            /belongs to ssh:cluster-a/,
        );
    });
});
