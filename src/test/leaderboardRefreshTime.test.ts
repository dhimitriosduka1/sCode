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
});
