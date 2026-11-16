import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    formatDataAge,
    formatLeaderboardRefreshLabel,
    formatPartitionDataFreshness,
    showRefreshTime,
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
});

describe('showRefreshTime', () => {
    const refreshedAt = new Date();
    const label = formatLeaderboardRefreshLabel(refreshedAt);

    it('puts when the data was fetched in the view\'s title bar', () => {
        const view: { description?: string } = {};

        showRefreshTime(view, refreshedAt);
        assert.equal(view.description, label);
    });

    it('clears it when there is no data, rather than show an old time', () => {
        const view = { description: label };

        showRefreshTime(view, undefined);
        assert.equal(view.description, undefined);
    });

    it('does nothing before the view exists', () => {
        assert.doesNotThrow(() => showRefreshTime(undefined, refreshedAt));
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
