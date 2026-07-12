import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { HistoryJob } from '../slurmService';
import {
    calculateJobEfficiency,
    formatHistoryJobDescription,
    formatHistorySummaryDescription,
    formatHistorySummaryTooltip,
    formatJobEfficiencyPercentLabel,
    getJobEfficiencyIndicator,
    groupHistoryJobsByEndDate,
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
        totalCpuTime: '12:00:00',
        allocMemory: '128G',
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

    it('formats summary descriptions with and without a search filter', () => {
        assert.equal(formatHistorySummaryDescription(7, 42), 'Last 7 days · 42 jobs');
        assert.equal(formatHistorySummaryDescription(1, 1), 'Last 1 day · 1 job');
        assert.equal(formatHistorySummaryDescription(30, 42, 3, 'train'), 'Last 30 days · 3 of 42 jobs');
    });

    it('formats history summary tooltip markdown', () => {
        const refreshedAt = new Date('2026-04-28T14:05:00');

        assert.equal(formatHistorySummaryTooltip(refreshedAt, 7, 42, 3, 'train'), [
            '**Job History refresh**',
            '',
            `- **Fetched at:** ${refreshedAt.toLocaleString()}`,
            '- **Range:** Last 7 days',
            '- **Jobs:** 3 of 42',
            '- **Filter:** train',
            '',
            'Use Refresh Job History to update it, or Set Job History Range to change the lookback window.',
        ].join('\n'));
    });

    it('normalizes history day ranges', () => {
        assert.equal(normalizeHistoryDays(0), 1);
        assert.equal(normalizeHistoryDays(7.8), 7);
        assert.equal(normalizeHistoryDays(1000), 365);
        assert.equal(normalizeHistoryDays(Number.NaN), 7);
    });

    it('calculates CPU and memory efficiency from allocated vs. used resources', () => {
        const efficiency = calculateJobEfficiency(historyJob({}));

        assert.equal(Math.round(efficiency.cpuPercent!), 49); // 12:00:00 of 16 CPUs * 1h32m allocated
        assert.equal(Math.round(efficiency.memoryPercent!), 56); // 72G used of 128G allocated
    });

    it('caps efficiency at 100% when usage reports exceed the allocation', () => {
        const efficiency = calculateJobEfficiency(historyJob({
            cpus: '4',
            elapsed: '01:00:00',
            totalCpuTime: '10:00:00', // more core-hours used than allocated (rounding/oversubscription)
            allocMemory: '8G',
            maxMemory: '16G',
        }));

        assert.equal(efficiency.cpuPercent, 100);
        assert.equal(efficiency.memoryPercent, 100);
    });

    it('returns undefined efficiency when the underlying sacct fields are unavailable', () => {
        const efficiency = calculateJobEfficiency(historyJob({
            totalCpuTime: 'N/A',
            allocMemory: 'N/A',
        }));

        assert.equal(efficiency.cpuPercent, undefined);
        assert.equal(efficiency.memoryPercent, undefined);
    });

    it('formats efficiency percentages, falling back to N/A when undefined', () => {
        assert.equal(formatJobEfficiencyPercentLabel(48.91), '49%');
        assert.equal(formatJobEfficiencyPercentLabel(undefined), 'N/A');
    });

    it('picks a warning indicator below 50%, a caution indicator below 80%, and success at or above 80%', () => {
        assert.deepEqual(getJobEfficiencyIndicator(10), { icon: 'warning', color: 'charts.red' });
        assert.deepEqual(getJobEfficiencyIndicator(65), { icon: 'warning', color: 'charts.yellow' });
        assert.deepEqual(getJobEfficiencyIndicator(95), { icon: 'check', color: 'charts.green' });
    });
});
