import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    formatDataAge,
    formatLeaderboardRefreshLabel,
    formatLeaderboardRefreshTooltip,
    formatPartitionDataFreshness,
} from '../leaderboardRefreshTime';

describe('leaderboard refresh time formatting', () => {
    it('shows only the time for refreshes from today', () => {
        const refreshedAt = new Date(2026, 3, 28, 9, 5, 7);
        const now = new Date(2026, 3, 28, 12, 0, 0);
        const expectedTime = refreshedAt.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        assert.equal(formatLeaderboardRefreshLabel(refreshedAt, now), `Last refreshed: ${expectedTime}`);
    });

    it('includes the date for refreshes from a previous day', () => {
        const refreshedAt = new Date(2026, 3, 27, 23, 59, 1);
        const now = new Date(2026, 3, 28, 12, 0, 0);
        const expectedDate = refreshedAt.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
        });
        const expectedTime = refreshedAt.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        assert.equal(formatLeaderboardRefreshLabel(refreshedAt, now), `Last refreshed: ${expectedDate}, ${expectedTime}`);
    });

    it('explains how to update stale Hall of Shame data in the tooltip', () => {
        const refreshedAt = new Date(2026, 3, 28, 9, 5, 7);

        assert.equal(
            formatLeaderboardRefreshTooltip(refreshedAt),
            [
                '**Hall of Shame refresh**',
                '',
                `- **Fetched at:** ${refreshedAt.toLocaleString()}`,
                '',
                'Use Refresh Hall of Shame to update it.',
            ].join('\n')
        );
    });

    it('formats view-specific refresh tooltip text', () => {
        const refreshedAt = new Date(2026, 3, 28, 9, 5, 7);

        assert.equal(
            formatLeaderboardRefreshTooltip(refreshedAt, {
                title: 'Cluster Overview refresh',
                refreshCommandLabel: 'Refresh Cluster Overview',
            }),
            [
                '**Cluster Overview refresh**',
                '',
                `- **Fetched at:** ${refreshedAt.toLocaleString()}`,
                '',
                'Use Refresh Cluster Overview to update it.',
            ].join('\n')
        );
    });

    it('states the background refresh interval for auto-refreshing views', () => {
        const refreshedAt = new Date(2026, 3, 28, 9, 5, 7);

        assert.equal(
            formatLeaderboardRefreshTooltip(refreshedAt, {
                title: 'GPU Partition Usage refresh',
                refreshCommandLabel: 'Refresh GPU Partition Usage',
                autoRefreshMinutes: 5,
            }),
            [
                '**GPU Partition Usage refresh**',
                '',
                `- **Fetched at:** ${refreshedAt.toLocaleString()}`,
                '- **Auto-refresh:** every 5 min',
                '',
                'Use Refresh GPU Partition Usage to update it now.',
            ].join('\n')
        );
    });

    it('says when background refresh is turned off', () => {
        const markdown = formatLeaderboardRefreshTooltip(new Date(2026, 3, 28, 9, 5, 7), { autoRefreshMinutes: 0 });

        assert.match(markdown, /- \*\*Auto-refresh:\*\* off/);
        assert.match(markdown, /to update it\.$/);
    });
});

describe('formatDataAge', () => {
    const now = new Date(2026, 9, 9, 14, 30, 0);
    const ago = (ms: number) => formatDataAge(new Date(now.getTime() - ms), now);

    it('says just now within the first minute', () => {
        assert.equal(ago(0), 'just now');
        assert.equal(ago(59_000), 'just now');
    });

    it('counts minutes, then hours', () => {
        assert.equal(ago(60_000), '1 min ago');
        assert.equal(ago(59 * 60_000), '59 min ago');
        assert.equal(ago(3 * 60 * 60_000), '3 h ago');
    });

    it('gives the date once the data is from another day', () => {
        assert.equal(ago(15 * 60 * 60_000), 'on Oct 8');
    });
});

describe('formatPartitionDataFreshness', () => {
    it('shows the age with a refresh button', () => {
        const now = new Date(2026, 9, 9, 14, 30, 0);
        assert.equal(
            formatPartitionDataFreshness(new Date(now.getTime() - 4 * 60_000), now),
            'Updated 4 min ago &nbsp; [$(refresh)](command:slurmPartitionUsage.refresh "Refresh partition data")',
        );
    });
});
