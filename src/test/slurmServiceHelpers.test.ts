import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    calculateProgress,
    expandPathPlaceholders,
    formatStartTime,
    generateProgressBar,
    getHistoryStateInfo,
    getStateDescription,
    hasUnresolvedSlurmPathPlaceholders,
    normalizeOpenableFilePath,
    normalizeSlurmPathValue,
    parseJobDetailsOutput,
    parseTimeToSeconds,
} from '../slurmService';

describe('Slurm service helper functions', () => {
    it('maps active job state codes to readable descriptions', () => {
        assert.equal(getStateDescription('R'), 'Running');
        assert.equal(getStateDescription('PD'), 'Pending');
        assert.equal(getStateDescription('CG'), 'Completing');
        assert.equal(getStateDescription('NF'), 'Node Fail');
        assert.equal(getStateDescription('SITE_CUSTOM'), 'SITE_CUSTOM');
    });

    it('parses Slurm time formats into seconds', () => {
        assert.equal(parseTimeToSeconds('30'), 30);
        assert.equal(parseTimeToSeconds('30:00'), 1800);
        assert.equal(parseTimeToSeconds('01:02:03'), 3723);
        assert.equal(parseTimeToSeconds('1-00:30:00'), 88200);
    });

    it('returns -1 for unavailable or invalid time strings', () => {
        assert.equal(parseTimeToSeconds(''), -1);
        assert.equal(parseTimeToSeconds('N/A'), -1);
        assert.equal(parseTimeToSeconds('UNLIMITED'), -1);
        assert.equal(parseTimeToSeconds('INVALID'), -1);
    });

    it('calculates capped progress percentages', () => {
        assert.equal(calculateProgress('00:30:00', '01:00:00'), 50);
        assert.equal(calculateProgress('00:40:00', '01:00:00'), 67);
        assert.equal(calculateProgress('02:00:00', '01:00:00'), 100);
        assert.equal(calculateProgress('N/A', '01:00:00'), -1);
        assert.equal(calculateProgress('00:30:00', '00:00:00'), -1);
    });

    it('generates progress bars without resizing callers needing to know the symbols', () => {
        assert.equal(generateProgressBar(-1, 4), '');
        assert.equal(generateProgressBar(50, 4), '\u25cf\u25cf\u25cb\u25cb 50%');
        assert.equal(generateProgressBar(25, 8), '\u25cf\u25cf\u25cb\u25cb\u25cb\u25cb\u25cb\u25cb 25%');
        assert.equal(generateProgressBar(100, 3), '\u25cf\u25cf\u25cf 100%');
    });

    it('formats unavailable and parseable start times for display', () => {
        assert.equal(formatStartTime(''), 'TBD');
        assert.equal(formatStartTime('N/A'), 'TBD');
        assert.equal(formatStartTime('Unknown'), 'TBD');
        assert.equal(formatStartTime('not-a-date'), 'not-a-date');

        const future = new Date(2099, 0, 2, 3, 4, 0);
        const expectedFuture = future.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        assert.equal(formatStartTime(future.toISOString()), expectedFuture);
    });

    it('expands Slurm output path placeholders', () => {
        assert.equal(expandPathPlaceholders('', '123', 'train', 'node01'), '');
        assert.equal(expandPathPlaceholders('N/A', '123', 'train', 'node01'), 'N/A');
        assert.equal(expandPathPlaceholders('(null)', '123', 'train', 'node01'), 'N/A');

        assert.equal(
            expandPathPlaceholders('logs/%x-%j-%N-%A-%a-%t-%%.out', '123_7', 'train', 'node[01-02]'),
            'logs/train-123_7-node01-123-7-0-%.out'
        );

        assert.equal(
            expandPathPlaceholders('logs/%A-%a-%b-%s-%N.out', '123_17.3', 'array-step', 'gpu-node[03-04,07]'),
            'logs/123-17-7-3-gpu-node03.out'
        );

        assert.equal(
            expandPathPlaceholders('logs/%x-%j-%N.out', '456', 'pending', 'N/A'),
            'logs/pending-456-PENDING_NODE.out'
        );

        assert.equal(
            expandPathPlaceholders('logs/%x-%j.out', '456', 'train', 'node01', '/scratch/run'),
            path.join('/scratch/run', 'logs/train-456.out')
        );

        assert.equal(
            expandPathPlaceholders('~/slurm-%j.out', '456', 'train', 'node01'),
            path.join(os.homedir(), 'slurm-456.out')
        );
    });

    it('normalizes Slurm path values and openable file paths', () => {
        assert.equal(normalizeSlurmPathValue(' "(null)" '), 'N/A');
        assert.equal(normalizeSlurmPathValue(" 'unknown' "), 'N/A');
        assert.equal(normalizeSlurmPathValue('none'), 'N/A');
        assert.equal(normalizeSlurmPathValue('logs/my\\040file.out'), 'logs/my file.out');
        assert.equal(normalizeOpenableFilePath('relative.out', '/workspace'), path.join('/workspace', 'relative.out'));
        assert.equal(normalizeOpenableFilePath('N/A'), undefined);
    });

    it('detects unresolved Slurm path placeholders', () => {
        assert.equal(hasUnresolvedSlurmPathPlaceholders('/logs/slurm-%j.out'), true);
        assert.equal(hasUnresolvedSlurmPathPlaceholders('/logs/slurm-%%.out'), false);
        assert.equal(hasUnresolvedSlurmPathPlaceholders('/logs/slurm-123.out'), false);
    });

    it('parses scontrol job details with path normalization', () => {
        const details = parseJobDetailsOutput([
            'JobId=123 JobName=train',
            'StdOut=logs/my\\040stdout-%j.out',
            'StdErr="logs/stderr-%A_%a.err"',
            'Command=train.sbatch',
            'WorkDir=/scratch/run',
            'Dependency=(null)',
            'AllocTRES=cpu=8,mem=16000M,gres/gpu:a100=2',
        ].join(' '));

        assert.deepEqual(details, {
            stdoutPath: 'logs/my stdout-%j.out',
            stderrPath: 'logs/stderr-%A_%a.err',
            submitScript: 'train.sbatch',
            workDir: '/scratch/run',
            gpuCount: 2,
            gpuType: 'A100',
            memory: '16G',
            dependency: undefined,
        });
    });

    it('parses unavailable scontrol path values consistently', () => {
        const details = parseJobDetailsOutput([
            'JobId=456 JobName=pending',
            'StdOut=(null)',
            'StdErr=none',
            'Command=UNKNOWN',
            'WorkDir=N/A',
            'Dependency=None',
        ].join(' '));

        assert.equal(details.stdoutPath, 'N/A');
        assert.equal(details.stderrPath, 'N/A');
        assert.equal(details.submitScript, 'N/A');
        assert.equal(details.workDir, 'N/A');
        assert.equal(details.dependency, undefined);
    });

    it('summarizes history job states with icon metadata', () => {
        assert.deepEqual(getHistoryStateInfo('COMPLETED', 0), {
            icon: 'check',
            color: 'charts.green',
            description: 'Completed Successfully',
        });
        assert.deepEqual(getHistoryStateInfo('COMPLETED', 2), {
            icon: 'error',
            color: 'charts.red',
            description: 'Failed (exit code 2)',
        });
        assert.deepEqual(getHistoryStateInfo('FAILED', 1), {
            icon: 'error',
            color: 'charts.red',
            description: 'Failed',
        });
        assert.deepEqual(getHistoryStateInfo('TIMEOUT', 0), {
            icon: 'clock',
            color: 'charts.orange',
            description: 'Timeout',
        });
        assert.deepEqual(getHistoryStateInfo('CANCELLED by 1234', 0), {
            icon: 'circle-slash',
            color: 'charts.orange',
            description: 'Cancelled',
        });
        assert.deepEqual(getHistoryStateInfo('NODE_FAIL', 0), {
            icon: 'error',
            color: 'charts.red',
            description: 'Node Failure',
        });
        assert.deepEqual(getHistoryStateInfo('OUT_OF_ME+', 0), {
            icon: 'warning',
            color: 'charts.red',
            description: 'Out of Memory',
        });
        assert.deepEqual(getHistoryStateInfo('PREEMPTED', 0), {
            icon: 'debug-pause',
            color: 'charts.yellow',
            description: 'Preempted',
        });
        assert.deepEqual(getHistoryStateInfo('SITE_CUSTOM', 0), {
            icon: 'circle-outline',
            color: 'foreground',
            description: 'SITE_CUSTOM',
        });
    });
});
