import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatLeaderboardRefreshLabel, formatLeaderboardRefreshTooltip } from '../leaderboardRefreshTime';

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
