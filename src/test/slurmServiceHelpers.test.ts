import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    calculateProgress,
    calculateRemainingSeconds,
    expandPathPlaceholders,
    formatDuration,
    formatRemainingTime,
    formatStartTime,
    generateProgressBar,
    getHistoryStateInfo,
    isNearTimeLimit,
    getStateDescription,
    hasUnresolvedSlurmPathPlaceholders,
    normalizeOpenableFilePath,
    normalizeSlurmPathValue,
    parseJobDetailsOutput,
    parseTimeToSeconds,
    TIME_LIMIT_WARNING_MAX_REMAINING_SECONDS,
    TIME_LIMIT_WARNING_PROGRESS,
    cleanJobIdForScontrol,
    extractBaseJobId,
    resolvePathWithoutPlaceholders,
    SlurmJob,
} from '../slurmService';

describe('Slurm service helper functions', () => {
    it('maps active job state codes to readable descriptions', () => {
        assert.equal(getStateDescription('R'), 'Running');
        assert.equal(getStateDescription('CF'), 'Configuring');
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

    it('prefers total AllocTRES GPUs over per-node TresPerNode counts', () => {
        const details = parseJobDetailsOutput([
            'JobId=789 JobName=multi-node',
            'NumNodes=4',
            'TresPerNode=gres/gpu:a100:4',
            'AllocTRES=cpu=288,mem=1875G,gres/gpu:a100=16',
            'StdOut=/logs/out',
            'StdErr=/logs/err',
            'Command=train.sbatch',
            'WorkDir=/scratch/run',
        ].join(' '));

        assert.equal(details.gpuCount, 16);
        assert.equal(details.gpuType, 'A100');
    });

    it('multiplies TresPerNode GPUs by NumNodes when AllocTRES is unavailable', () => {
        const details = parseJobDetailsOutput([
            'JobId=790 JobName=multi-node',
            'NumNodes=4',
            'TresPerNode=gres/gpu:a100:4',
            'StdOut=/logs/out',
            'StdErr=/logs/err',
            'Command=train.sbatch',
            'WorkDir=/scratch/run',
        ].join(' '));

        assert.equal(details.gpuCount, 16);
        assert.equal(details.gpuType, 'A100');
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

    it('handles duplicate generic and specific GRES allocations without double counting GPUs', () => {
        const details = parseJobDetailsOutput([
            'JobId=555 JobName=double-count-test',
            'NumNodes=1',
            'AllocTRES=cpu=96,mem=1000G,node=1,billing=96,gres/gpu=8,gres/gpu:b200=8',
            'StdOut=/logs/out',
            'StdErr=/logs/err',
            'Command=train.sbatch',
            'WorkDir=/scratch/run',
        ].join(' '));

        assert.equal(details.gpuCount, 8);
        assert.equal(details.gpuType, 'B200');
    });

    it('cleans job IDs correctly for scontrol queries', () => {
        assert.equal(cleanJobIdForScontrol('269277_[1-10]'), '269277');
        assert.equal(cleanJobIdForScontrol('269277_[1-10%5]'), '269277');
        assert.equal(cleanJobIdForScontrol('269277_[1]'), '269277');
        assert.equal(cleanJobIdForScontrol('269277_1'), '269277_1');
        assert.equal(cleanJobIdForScontrol('269277'), '269277');
    });

    it('extracts base job ID correctly', () => {
        assert.equal(extractBaseJobId('269277_1'), '269277');
        assert.equal(extractBaseJobId('269277_[1-10]'), '269277');
        assert.equal(extractBaseJobId('269277'), '269277');
    });

    it('resolves path values without expanding placeholders', () => {
        assert.equal(resolvePathWithoutPlaceholders('N/A', '/work'), 'N/A');
        assert.equal(resolvePathWithoutPlaceholders('', '/work'), 'N/A');
        assert.equal(
            resolvePathWithoutPlaceholders('logs/%x-%j-%N.out', '/work'),
            path.resolve('/work', 'logs/%x-%j-%N.out')
        );
        assert.equal(
            resolvePathWithoutPlaceholders('/absolute/logs/%x-%j.out', '/work'),
            '/absolute/logs/%x-%j.out'
        );
    });
});

describe('calculateRemainingSeconds', () => {
    it('returns the seconds left before the wall-clock limit', () => {
        assert.equal(calculateRemainingSeconds('00:57:00', '01:00:00'), 180);
        assert.equal(calculateRemainingSeconds('6-12:00:00', '7-00:00:00'), 43200);
    });

    // squeue can report an elapsed time a tick past the limit while the job is
    // being killed; a negative remainder is not worth rendering.
    it('clamps a job already past its limit to zero', () => {
        assert.equal(calculateRemainingSeconds('01:00:30', '01:00:00'), 0);
    });

    it('reports no remainder without a usable limit', () => {
        assert.equal(calculateRemainingSeconds('00:57:00', 'UNLIMITED'), -1);
        assert.equal(calculateRemainingSeconds('00:57:00', 'N/A'), -1);
        assert.equal(calculateRemainingSeconds('N/A', '01:00:00'), -1);
    });
});

describe('formatDuration', () => {
    it('keeps the two largest units, dropping zeros', () => {
        assert.equal(formatDuration(0), '0s');
        assert.equal(formatDuration(59), '59s');
        assert.equal(formatDuration(60), '1m');
        assert.equal(formatDuration(3275), '54m');
        assert.equal(formatDuration(3600), '1h');
        assert.equal(formatDuration(3900), '1h 5m');
        assert.equal(formatDuration(86400), '1d');
        assert.equal(formatDuration(2 * 86400 + 4 * 3600 + 59), '2d 4h');
    });
});

describe('formatRemainingTime', () => {
    it('counts seconds under a minute', () => {
        assert.equal(formatRemainingTime(0), '0s left');
        assert.equal(formatRemainingTime(59), '59s left');
    });

    it('counts whole minutes under an hour', () => {
        assert.equal(formatRemainingTime(60), '1m left');
        assert.equal(formatRemainingTime(3599), '59m left');
    });

    it('carries hours with minutes, dropping a zero remainder', () => {
        assert.equal(formatRemainingTime(3600), '1h left');
        assert.equal(formatRemainingTime(3660), '1h 1m left');
        assert.equal(formatRemainingTime(86399), '23h 59m left');
    });

    it('carries days with hours for long wall clocks', () => {
        assert.equal(formatRemainingTime(86400), '1d left');
        assert.equal(formatRemainingTime(90000), '1d 1h left');
        assert.equal(formatRemainingTime(7 * 86400), '7d left');
    });

    it('renders nothing for an unknown remainder', () => {
        assert.equal(formatRemainingTime(-1), '');
    });
});

describe('isNearTimeLimit', () => {
    function runningJob(time: string, timeLimit: string, state: string = 'R'): SlurmJob {
        return {
            jobId: '91001',
            name: 'train-transformer',
            state,
            time,
            partition: 'gpu',
            nodes: 'node-a',
            stdoutPath: '/tmp/out',
            stderrPath: '/tmp/err',
            timeLimit,
            startTime: 'N/A',
            workDir: '/tmp',
            submitScript: '/tmp/job.slurm',
        };
    }

    it('warns from the threshold onwards', () => {
        assert.equal(TIME_LIMIT_WARNING_PROGRESS, 90);
        assert.equal(isNearTimeLimit(runningJob('00:54:00', '01:00:00')), true);
        assert.equal(isNearTimeLimit(runningJob('00:59:00', '01:00:00')), true);
    });

    it('stays quiet below the threshold', () => {
        assert.equal(isNearTimeLimit(runningJob('00:53:00', '01:00:00')), false);
        assert.equal(isNearTimeLimit(runningJob('00:21:00', '01:00:00')), false);
    });

    // The progress gate scales with the limit, so without a cap a week-long job
    // would warn with seventeen hours still to run.
    it('stays quiet on a long job that is proportionally near its limit', () => {
        assert.equal(TIME_LIMIT_WARNING_MAX_REMAINING_SECONDS, 7200);
        // 93% of seven days, but half a day still to run.
        assert.equal(isNearTimeLimit(runningJob('6-12:00:00', '7-00:00:00')), false);
    });

    it('warns on a long job once it is actually within the cap', () => {
        // 7 days less 90 minutes.
        assert.equal(isNearTimeLimit(runningJob('6-22:30:00', '7-00:00:00')), true);
    });

    it('treats the cap as inclusive', () => {
        // Exactly two hours left, and past the progress gate on a 24h limit.
        assert.equal(isNearTimeLimit(runningJob('22:00:00', '1-00:00:00')), true);
        assert.equal(isNearTimeLimit(runningJob('21:59:00', '1-00:00:00')), false);
    });

    // Below roughly a twenty-hour limit, 10% of the limit is already under the
    // cap, so the cap never binds and the progress gate decides alone.
    it('leaves ordinary job lengths to the progress gate', () => {
        assert.equal(isNearTimeLimit(runningJob('05:46:00', '06:00:00')), true);
        assert.equal(isNearTimeLimit(runningJob('00:54:00', '01:00:00')), true);
        assert.equal(isNearTimeLimit(runningJob('00:53:00', '01:00:00')), false);
    });

    // A job with no wall clock can never approach one.
    it('never warns without a usable limit', () => {
        assert.equal(isNearTimeLimit(runningJob('10-00:00:00', 'UNLIMITED')), false);
        assert.equal(isNearTimeLimit(runningJob('00:59:00', 'N/A')), false);
    });

    it('only applies to running jobs', () => {
        assert.equal(isNearTimeLimit(runningJob('00:59:00', '01:00:00', 'PD')), false);
        assert.equal(isNearTimeLimit(runningJob('00:59:00', '01:00:00', 'CG')), false);
    });
});

describe('generateProgressBar trailing label', () => {
    it('shows the percentage by default', () => {
        assert.equal(generateProgressBar(95, 8), '●●●●●●●● 95%');
    });

    it('replaces the percentage when given a label', () => {
        assert.equal(generateProgressBar(95, 8, '3m left'), '●●●●●●●● 3m left');
    });

    it('still renders nothing for an uncomputable progress', () => {
        assert.equal(generateProgressBar(-1, 8, '3m left'), '');
    });
});
