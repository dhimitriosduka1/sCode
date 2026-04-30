import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { getRemoteSubmitPromptOptions } from '../remoteSubmit';

describe('remote submit prompt options', () => {
    it('prefills the path only for remote Slurm documents', () => {
        assert.deepEqual(getRemoteSubmitPromptOptions({
            scheme: 'slurm-remote',
            path: '/remote/project/train.sbatch',
            fileName: 'train.sbatch',
        }), {
            title: 'Submit Remote SLURM Script',
            prompt: 'Submit this existing remote SLURM script path.',
            placeHolder: '/remote/project/train.sbatch',
            initialValue: '/remote/project/train.sbatch',
        });
    });

    it('does not guess a remote path from a local file', () => {
        const options = getRemoteSubmitPromptOptions({
            scheme: 'file',
            path: '/Users/local/project/train.sbatch',
            fileName: 'train.sbatch',
        });

        assert.equal(options.initialValue, undefined);
        assert.match(options.prompt, /not uploaded or path-mapped/);
        assert.equal(options.placeHolder, '/home/user/project/train.sbatch');
    });
});
