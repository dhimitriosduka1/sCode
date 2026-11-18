import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { HistoryJob } from '../slurmService';
import {
    formatHistoryElapsed,
    formatHistoryJobDescription,
    formatHistorySearchMessage,
    groupHistoryJobsByEndDate,
    matchesHistorySearch,
    normalizeHistoryDays,
} from '../historyViewModel';

function historyJob(overrides: Partial<HistoryJob>): HistoryJob {
    return {
        jobId: '90990',
        name: 'finished-training',
        state: 'COMPLETED',
        exitCode: 0,
        startTime: '2026-04-28T10:00:00',
        endTime: '2026-04-28T11:32:00',
        elapsed: '01:32:00',
        partition: 'gpu',
        nodes: 'gpu-node[03]',
        cpus: '16',
        maxMemory: '72G',
        timeLimit: '02:00:00',
        stdoutPath: 'N/A',
        stderrPath: 'N/A',
        ...overrides,
    };
}

describe('history view model', () => {
    it('groups history jobs by end date with readable labels', () => {
        const now = new Date('2026-04-28T14:00:00');
        const groups = groupHistoryJobsByEndDate([
            historyJob({ jobId: '1', endTime: '2026-04-28T11:32:00' }),
            historyJob({ jobId: '2', endTime: '2026-04-27T12:03:00' }),
            historyJob({ jobId: '3', endTime: '2026-04-26T09:00:00' }),
        ], now);

        assert.deepEqual(groups.map(group => ({
            key: group.key,
            label: group.label,
            jobIds: group.jobs.map(job => job.jobId),
        })), [
            { key: '2026-04-28', label: 'Today (1)', jobIds: ['1'] },
            { key: '2026-04-27', label: 'Yesterday (1)', jobIds: ['2'] },
            { key: '2026-04-26', label: 'Apr 26 (1)', jobIds: ['3'] },
        ]);
    });

    it('includes every array task in the date count while keeping one grouped record', () => {
        const now = new Date('2026-04-28T14:00:00');
        const jobs = [historyJob({ jobId: '1' }), historyJob({ jobId: '2_[1-100]' })];
        const [group] = groupHistoryJobsByEndDate(jobs, now);
        assert.equal(group.label, 'Today (101)');
        assert.deepEqual(group.jobs, jobs);
    });

    it('formats successful history job rows with ended time and compact elapsed time', () => {
        const now = new Date('2026-04-28T14:00:00');

        assert.equal(
            formatHistoryJobDescription(historyJob({}), now),
            '90990 • Completed Successfully • ended 11:32 • 1h32m'
        );
    });

    it('formats problem history job rows with the failure state visible', () => {
        const now = new Date('2026-04-28T14:00:00');

        assert.equal(
            formatHistoryJobDescription(historyJob({
                jobId: '90991',
                state: 'FAILED',
                exitCode: 1,
                endTime: '2026-04-27T12:03:00',
                elapsed: '00:03:00',
            }), now),
            '90991 • Failed • ended yesterday 12:03 • 3m'
        );
    });

    it('normalizes history day ranges', () => {
        assert.equal(normalizeHistoryDays(0), 1);
        assert.equal(normalizeHistoryDays(7.8), 7);
        assert.equal(normalizeHistoryDays(1000), 365);
        assert.equal(normalizeHistoryDays(Number.NaN), 7);
    });

    it('says what a search left of the history, and nothing without one', () => {
        assert.equal(formatHistorySearchMessage('train', 3, 12), 'Search "train": 3 of 12 jobs');
        assert.equal(formatHistorySearchMessage('train', 1, 1), 'Search "train": 1 of 1 job');
        assert.equal(formatHistorySearchMessage('', 12, 12), undefined);
    });

    it('finds jobs by name, ID, or how they ended', () => {
        const timedOut = historyJob({ jobId: '45210', name: 'train-vit', state: 'TIMEOUT' });
        const outOfMemory = historyJob({ jobId: '45211', name: 'eval', state: 'OUT_OF_MEMORY' });

        assert.equal(matchesHistorySearch(timedOut, 'ViT'), true);
        assert.equal(matchesHistorySearch(timedOut, '4521'), true);
        assert.equal(matchesHistorySearch(timedOut, 'timeout'), true);
        assert.equal(matchesHistorySearch(timedOut, 'failed'), false);
        // As the view labels it, too
        assert.equal(matchesHistorySearch(outOfMemory, 'out of memory'), true);
        assert.equal(matchesHistorySearch(outOfMemory, 'OUT_OF'), true);

        // Slurm names who cancelled a job by user ID; digits meant for a job ID must not match it
        const cancelled = historyJob({ jobId: '45212', name: 'sweep', state: 'CANCELLED by 1000' });
        assert.equal(matchesHistorySearch(cancelled, 'cancelled'), true);
        assert.equal(matchesHistorySearch(cancelled, '100'), false);
    });

    it('puts the time limit the job asked for next to how long it ran', () => {
        assert.equal(formatHistoryElapsed('03:58:12', '04:00:00'), '03:58:12 of 04:00:00');
        assert.equal(formatHistoryElapsed('1-02:00:00', '2-00:00:00'), '1-02:00:00 of 2-00:00:00');
        // Limits that are not a duration, or none, leave it as it was
        assert.equal(formatHistoryElapsed('00:05:00', 'UNLIMITED'), '00:05:00');
        assert.equal(formatHistoryElapsed('00:05:00', 'Partition_Limit'), '00:05:00');
        assert.equal(formatHistoryElapsed('00:05:00', 'N/A'), '00:05:00');
    });
});
