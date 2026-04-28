import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    formatLeaderboardAccountLabel,
    formatLeaderboardEntryDescription,
    formatLeaderboardEntryRowDescription,
    formatLeaderboardEntryTrailingDescription,
    formatLeaderboardGpuShare,
    formatLeaderboardGpuTypeLabel,
    formatLeaderboardTooltipMarkdown,
    getGpuLeaderboardEntries,
    getLeaderboardEntryLabel,
    getLeaderboardEntryRowLabel,
    getTotalLeaderboardGpuCount,
    getVisibleLeaderboardEntries,
    LeaderboardEntry,
    MAX_LEADERBOARD_ENTRY_COUNT,
    MIN_LEADERBOARD_ENTRY_COUNT,
    normalizeLeaderboardEntryCount,
    RankedLeaderboardEntry,
    sortLeaderboardEntries,
} from '../leaderboardRanking';

function entry(
    username: string,
    gpuCount: number,
    gpuJobCount: number = gpuCount > 0 ? 1 : 0,
    accounts: string[] = ['test_inst'],
): LeaderboardEntry {
    return {
        username,
        accounts,
        gpuCount,
        gpuJobCount,
        gpuTypes: gpuCount > 0 ? [{ type: 'a100', count: gpuCount }] : [],
    };
}

function rankedEntry(
    username: string,
    rank: number,
    isCurrentUser: boolean,
): RankedLeaderboardEntry {
    return {
        username,
        rank,
        isCurrentUser,
        isOutsideTopEntries: false,
        accounts: ['test_inst'],
        gpuCount: 1,
        gpuJobCount: 1,
        gpuTypes: [{ type: 'a100', count: 1 }],
    };
}

describe('leaderboard ranking', () => {
    it('sorts GPU leaderboard entries by GPUs, then GPU jobs, then username', () => {
        const entries = [
            entry('zoe', 4, 1),
            entry('anna', 4, 3),
            entry('mike', 4, 3),
            entry('ben', 2, 5),
        ];

        assert.deepEqual(sortLeaderboardEntries(entries).map(e => e.username), [
            'anna',
            'mike',
            'zoe',
            'ben',
        ]);
    });

    it('filters CPU-only users out of the GPU leaderboard', () => {
        const entries = [
            entry('gpu-user', 4, 2, ['gpu_inst']),
            entry('cpu-user', 0, 0, []),
        ];

        assert.deepEqual(getGpuLeaderboardEntries(entries), [entry('gpu-user', 4, 2, ['gpu_inst'])]);
    });

    it('marks the current user when they are inside the top entries', () => {
        const visible = getVisibleLeaderboardEntries([
            entry('first', 10),
            entry('you', 5),
            entry('third', 3),
        ], 'you', 10);

        assert.deepEqual(visible.map(e => ({
            username: e.username,
            rank: e.rank,
            isCurrentUser: e.isCurrentUser,
            isOutsideTopEntries: e.isOutsideTopEntries,
        })), [
            { username: 'first', rank: 1, isCurrentUser: false, isOutsideTopEntries: false },
            { username: 'you', rank: 2, isCurrentUser: true, isOutsideTopEntries: false },
            { username: 'third', rank: 3, isCurrentUser: false, isOutsideTopEntries: false },
        ]);
    });

    it('appends the current user with their real rank when they are outside the top entries', () => {
        const entries = Array.from({ length: 12 }, (_, index) =>
            entry(`user-${index + 1}`, 20 - index)
        );
        entries.push(entry('you', 1));

        const visible = getVisibleLeaderboardEntries(entries, 'you', 5);

        assert.equal(visible.length, 6);
        assert.equal(visible[4].username, 'user-5');
        assert.deepEqual(visible[5], {
            username: 'you',
            accounts: ['test_inst'],
            gpuCount: 1,
            gpuJobCount: 1,
            gpuTypes: [{ type: 'a100', count: 1 }],
            rank: 13,
            isCurrentUser: true,
            isOutsideTopEntries: true,
        });
    });

    it('normalizes the configured leaderboard entry count', () => {
        assert.equal(normalizeLeaderboardEntryCount('5'), 5);
        assert.equal(normalizeLeaderboardEntryCount(5.9), 5);
        assert.equal(normalizeLeaderboardEntryCount(0), MIN_LEADERBOARD_ENTRY_COUNT);
        assert.equal(normalizeLeaderboardEntryCount(1000), MAX_LEADERBOARD_ENTRY_COUNT);
        assert.equal(normalizeLeaderboardEntryCount('not-a-number'), 10);
    });

    it('matches the current user case-insensitively and does not append duplicates', () => {
        const visible = getVisibleLeaderboardEntries([
            entry('MockUser', 5),
            entry('other', 4),
        ], 'mockuser', 10);

        assert.equal(visible.length, 2);
        assert.equal(visible[0].username, 'MockUser');
        assert.equal(visible[0].isCurrentUser, true);
    });

    it('does not add a current-user row when that user is absent', () => {
        const visible = getVisibleLeaderboardEntries([
            entry('first', 10),
            entry('second', 9),
        ], 'missing-user', 1);

        assert.deepEqual(visible.map(e => e.username), ['first']);
    });

    it('highlights the current user label without changing the row icon', () => {
        assert.deepEqual(getLeaderboardEntryLabel(rankedEntry('you', 12, true)), {
            label: '12. you',
            highlights: [[4, 7]],
        });

        assert.deepEqual(getLeaderboardEntryLabel(rankedEntry('someone-else', 4, false)), {
            label: '4. someone-else',
        });
    });

    it('formats the full visible leaderboard row as a single label', () => {
        const rowLabel = getLeaderboardEntryRowLabel({
            ...rankedEntry('mock-user', 1, false),
            accounts: ['mock_inst'],
            gpuCount: 6,
            gpuJobCount: 2,
            gpuTypes: [{ type: 'a100', count: 6 }],
        });

        assert.deepEqual(rowLabel, {
            label: '💀 mock-user mock_inst · 6 GPUs · 2 GPU jobs',
        });
    });

    it('highlights only the username in the full visible current-user row', () => {
        const rowLabel = getLeaderboardEntryRowLabel(rankedEntry('you', 12, true));

        assert.deepEqual(rowLabel, {
            label: '12. you test_inst · 1 GPUs · 1 GPU job',
            highlights: [[4, 7]],
        });
    });

    it('formats GPU leaderboard descriptions using only GPU jobs', () => {
        assert.equal(
            formatLeaderboardEntryDescription(entry('mixed-user', 4, 2, ['mswk_inst'])),
            'mswk_inst · 4 GPUs · 2 GPU jobs'
        );
        assert.equal(
            formatLeaderboardEntryDescription(entry('single-gpu-job', 1, 1, [])),
            '1 GPUs · 1 GPU job'
        );
    });

    it('formats GPU leaderboard row descriptions with cluster share progress at the end', () => {
        assert.equal(
            formatLeaderboardEntryRowDescription(entry('mixed-user', 4, 2, ['mswk_inst']), 16),
            'mswk_inst · 4 GPUs · 2 GPU jobs · ●●○○○○○○ 25%'
        );
    });

    it('formats the trailing leaderboard description as only the cluster share progress', () => {
        assert.equal(
            formatLeaderboardEntryTrailingDescription(entry('mixed-user', 4, 2, ['mswk_inst']), 16),
            '●●○○○○○○ 25%'
        );
    });

    it('formats compact Slurm account labels', () => {
        assert.equal(formatLeaderboardAccountLabel([]), '');
        assert.equal(formatLeaderboardAccountLabel(['mswk_inst']), 'mswk_inst');
        assert.equal(formatLeaderboardAccountLabel(['a_inst', 'b_inst']), 'a_inst, b_inst');
        assert.equal(formatLeaderboardAccountLabel(['a_inst', 'b_inst', 'c_inst']), 'a_inst, b_inst +1');
    });

    it('formats GPU type labels for tooltips', () => {
        assert.equal(formatLeaderboardGpuTypeLabel([]), 'Unknown');
        assert.equal(formatLeaderboardGpuTypeLabel([{ type: 'a100', count: 4 }]), 'a100: 4 GPUs');
        assert.equal(formatLeaderboardGpuTypeLabel([{ type: 'h200', count: 1 }]), 'h200: 1 GPU');
        assert.equal(
            formatLeaderboardGpuTypeLabel([
                { type: 'a100', count: 4 },
                { type: 'h200', count: 2 },
            ]),
            'a100: 4 GPUs, h200: 2 GPUs'
        );
    });

    it('computes the total allocated GPUs across leaderboard entries', () => {
        assert.equal(getTotalLeaderboardGpuCount([
            entry('first', 8),
            entry('second', 4),
            entry('cpu-only', 0, 0, []),
        ]), 12);
    });

    it('formats cluster GPU share labels', () => {
        assert.equal(formatLeaderboardGpuShare(4, 16), '●●○○○○○○ 25%');
        assert.equal(formatLeaderboardGpuShare(2, 24), '●○○○○○○○ 8%');
        assert.equal(formatLeaderboardGpuShare(1, 2000), '○○○○○○○○ 0%');
        assert.equal(formatLeaderboardGpuShare(4, 0), '');
    });

    it('formats leaderboard tooltips as separated markdown blocks', () => {
        const tooltip = formatLeaderboardTooltipMarkdown({
            ...rankedEntry('mock-user', 1, false),
            accounts: ['mock_inst'],
            gpuCount: 6,
            gpuJobCount: 2,
            gpuTypes: [
                { type: 'a100', count: 4 },
                { type: 'h200', count: 2 },
            ],
        }, 10);

        assert.equal(tooltip, [
            '**mock-user**',
            '',
            'Rank #1 · 6 GPUs · 2 GPU jobs',
            '',
            '- **Slurm account:** mock_inst',
            '- **GPU types:** a100: 4 GPUs, h200: 2 GPUs',
        ].join('\n'));
    });

    it('adds current-user tooltip context in its own paragraph', () => {
        const tooltip = formatLeaderboardTooltipMarkdown({
            ...rankedEntry('you', 12, true),
            isOutsideTopEntries: true,
        }, 10);

        assert.match(tooltip, /\n\nYour row is shown outside the configured top 10\.$/);
    });

    it('does not add extra tooltip text when the current user is already inside the visible entries', () => {
        const tooltip = formatLeaderboardTooltipMarkdown(rankedEntry('you', 2, true), 10);

        assert.doesNotMatch(tooltip, /This is your row/);
        assert.doesNotMatch(tooltip, /Your row is shown outside/);
        assert.doesNotMatch(tooltip, /Cluster GPU share/);
    });
});
