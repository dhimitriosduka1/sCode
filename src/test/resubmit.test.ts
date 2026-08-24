import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildResubmitPlan,
    describeResubmitOrigin,
    formatResubmitConfirmation,
    isUsableResubmitPath,
    pickDefaultResubmitOrigin,
    resolveResubmitWorkDir,
    shouldPromptForResubmitOrigin,
} from '../resubmit';

describe('resubmit path usability', () => {
    it('rejects the placeholder values Slurm reports for missing paths', () => {
        for (const value of ['', '   ', 'N/A', '(null)', 'none', 'Unknown']) {
            assert.equal(isUsableResubmitPath(value), false, `expected ${JSON.stringify(value)} to be unusable`);
        }
    });

    it('accepts a real path', () => {
        assert.equal(isUsableResubmitPath('/work/lab/train.sbatch'), true);
    });

    it('rejects an undefined path', () => {
        assert.equal(isUsableResubmitPath(undefined), false);
    });
});

describe('picking a default resubmit origin', () => {
    it('prefers the snapshot, which is guaranteed to match what ran', () => {
        assert.equal(
            pickDefaultResubmitOrigin({ snapshotPath: '/storage/123.sbatch', currentPath: '/work/train.sbatch' }),
            'snapshot'
        );
    });

    it('falls back to the on-disk script when no snapshot was kept', () => {
        assert.equal(pickDefaultResubmitOrigin({ currentPath: '/work/train.sbatch' }), 'current');
    });

    it('returns undefined when neither copy survives', () => {
        assert.equal(pickDefaultResubmitOrigin({}), undefined);
        assert.equal(pickDefaultResubmitOrigin({ snapshotPath: 'N/A', currentPath: '(null)' }), undefined);
    });
});

describe('prompting for a resubmit origin', () => {
    it('asks only when both copies exist and they differ', () => {
        assert.equal(
            shouldPromptForResubmitOrigin({
                snapshotPath: '/storage/123.sbatch',
                currentPath: '/work/train.sbatch',
                changed: true,
            }),
            true
        );
    });

    it('stays quiet when the script is unchanged', () => {
        assert.equal(
            shouldPromptForResubmitOrigin({
                snapshotPath: '/storage/123.sbatch',
                currentPath: '/work/train.sbatch',
                changed: false,
            }),
            false
        );
    });

    it('stays quiet when there is nothing to compare against', () => {
        assert.equal(shouldPromptForResubmitOrigin({ snapshotPath: '/storage/123.sbatch', changed: true }), false);
        assert.equal(shouldPromptForResubmitOrigin({ currentPath: '/work/train.sbatch', changed: true }), false);
    });
});

describe('resolving the resubmit working directory', () => {
    it('uses the working directory recorded for the original job', () => {
        assert.equal(
            resolveResubmitWorkDir({ workDir: '/work/lab/run', currentPath: '/home/me/scripts/train.sbatch' }),
            '/work/lab/run'
        );
    });

    it('falls back to the directory the script was submitted from', () => {
        assert.equal(resolveResubmitWorkDir({ currentPath: '/work/lab/train.sbatch' }), '/work/lab');
    });

    it('ignores unusable recorded working directories', () => {
        assert.equal(resolveResubmitWorkDir({ workDir: 'N/A', currentPath: '/work/lab/train.sbatch' }), '/work/lab');
    });

    it('never guesses from the snapshot, which lives in extension storage', () => {
        assert.equal(resolveResubmitWorkDir({ snapshotPath: '/storage/submit-scripts/123.sbatch' }), undefined);
    });
});

describe('building a resubmit plan', () => {
    it('submits the snapshot from the original working directory', () => {
        const plan = buildResubmitPlan(
            {
                snapshotPath: '/storage/submit-scripts/123_170.sbatch',
                currentPath: '/work/lab/train.sbatch',
                workDir: '/work/lab',
            },
            'snapshot'
        );

        assert.deepEqual(plan, {
            scriptPath: '/storage/submit-scripts/123_170.sbatch',
            workDir: '/work/lab',
            origin: 'snapshot',
        });
    });

    it('submits the current file when that is what was chosen', () => {
        const plan = buildResubmitPlan(
            { snapshotPath: '/storage/123.sbatch', currentPath: '/work/lab/train.sbatch' },
            'current'
        );

        assert.deepEqual(plan, {
            scriptPath: '/work/lab/train.sbatch',
            workDir: '/work/lab',
            origin: 'current',
        });
    });

    it('returns undefined when the chosen copy is missing', () => {
        assert.equal(buildResubmitPlan({ currentPath: '/work/lab/train.sbatch' }, 'snapshot'), undefined);
    });
});

describe('resubmit confirmation text', () => {
    it('names the job and which version it is', () => {
        const { message, detail } = formatResubmitConfirmation('train-transformer', '12345', {
            scriptPath: '/storage/submit-scripts/12345.sbatch',
            workDir: '/work/lab',
            origin: 'snapshot',
        });

        assert.equal(message, 'Resubmit "train-transformer"?');
        assert.ok(detail);
        assert.match(detail, /Job 12345/);
        assert.match(detail, /as originally submitted/);
        assert.match(detail, /Working directory: \/work\/lab/);
    });

    it('keeps the extension\'s private snapshot path out of the dialog', () => {
        const { message, detail } = formatResubmitConfirmation('train-transformer', '12345', {
            scriptPath: '/storage/submit-scripts/12345.sbatch',
            workDir: '/work/lab',
            origin: 'snapshot',
        });

        assert.equal(message.includes('/storage/submit-scripts'), false);
        assert.ok(detail);
        assert.equal(detail.includes('/storage/submit-scripts'), false);
    });

    it('drops the summary once the user has already picked a version', () => {
        const { message, detail } = formatResubmitConfirmation('train-transformer', '12345', {
            scriptPath: '/work/lab/train.sbatch',
            workDir: '/work/lab',
            origin: 'current',
        }, { originAlreadyChosen: true });

        assert.equal(message, 'Resubmit "train-transformer"?');
        assert.equal(detail, undefined);
    });

    it('omits the working directory line when none could be resolved', () => {
        const { detail } = formatResubmitConfirmation('cleanup', '999', {
            scriptPath: '/work/cleanup.sbatch',
            origin: 'current',
        });

        assert.ok(detail);
        assert.equal(detail.includes('Working directory'), false);
        assert.match(detail, /current version on disk/);
    });
});

describe('describing a resubmit origin', () => {
    it('distinguishes the two copies in plain language', () => {
        assert.equal(describeResubmitOrigin('snapshot'), 'as originally submitted');
        assert.equal(describeResubmitOrigin('current'), 'current version on disk');
    });
});
