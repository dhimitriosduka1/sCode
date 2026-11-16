import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    formatLeaderboardEntrySummary,
    formatLeaderboardGpuShare,
    formatLeaderboardGpuTypeLabel,
    formatLeaderboardTooltipMarkdown,
    getGpuLeaderboardEntries,
    getLeaderboardEntryDetails,
    getLeaderboardEntryRowLabel,
    getLeaderboardEmojiIconSvg,
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
        accountPartitions: {},
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
        accountPartitions: {},
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
            accountPartitions: {},
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

    it('keeps the row to the title or rank, and username, with nothing highlighted', () => {
        assert.deepEqual(getLeaderboardEntryRowLabel(rankedEntry('first', 1, false)), { label: 'Node Nom-Nom: first' });
        assert.deepEqual(getLeaderboardEntryRowLabel(rankedEntry('second', 2, false)), { label: 'CUDA Cuddler: second' });
        assert.deepEqual(getLeaderboardEntryRowLabel(rankedEntry('third', 3, false)), { label: 'Batch Bandit: third' });
        assert.deepEqual(getLeaderboardEntryRowLabel(rankedEntry('fourth', 4, false)), { label: '4. fourth' });
    });

    it('highlights the current user\'s username, not the same letters in the title', () => {
        // 'andi' is also in Bandit
        assert.deepEqual(getLeaderboardEntryRowLabel(rankedEntry('andi', 3, true)).highlights, [[14, 18]]);
    });

    it('highlights only the username in the current user\'s row below the top three', () => {
        assert.deepEqual(getLeaderboardEntryRowLabel(rankedEntry('you', 12, true)), {
            label: '12. you',
            highlights: [[4, 7]],
        });
    });

    it('draws the top three\'s emoji as their icon; the rest have none of their own', () => {
        assert.match(getLeaderboardEmojiIconSvg(1)!, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="16" height="16"/);
        assert.match(getLeaderboardEmojiIconSvg(1)!, /<text[^>]*>🦈<\/text>/);
        assert.match(getLeaderboardEmojiIconSvg(2)!, /<text[^>]*>🐨<\/text>/);
        assert.match(getLeaderboardEmojiIconSvg(3)!, /<text[^>]*>🐼<\/text>/);
        assert.equal(getLeaderboardEmojiIconSvg(4), undefined);
    });

    it('sums a row up as its GPUs, their share of the GPUs in use, and fair share', () => {
        const withFairShare = {
            ...entry('nova42', 24, 3, ['atlas_lab']),
            fairShare: {
                username: 'nova42',
                account: 'atlas_lab',
                fairShareFactor: 0.142857,
                source: 'only' as const,
                accounts: [{ account: 'atlas_lab', fairShareFactor: 0.142857 }],
            },
        };

        assert.equal(formatLeaderboardEntrySummary(withFairShare, 96), '24 GPUs (25%) · FS 0.143');
        assert.equal(formatLeaderboardEntrySummary(entry('solo', 1, 1), 2000), '1 GPU (0%)');
        assert.equal(formatLeaderboardEntrySummary(entry('solo', 1, 1), 0), '1 GPU');
    });

    it('names the partition the row\'s fair share account runs GPU jobs in', () => {
        const withPartitions = (partitions: string[]) => ({
            ...entry('nova42', 24, 3, ['atlas_lab']),
            accountPartitions: { atlas_lab: partitions },
            fairShare: {
                username: 'nova42',
                account: 'atlas_lab',
                fairShareFactor: 0.142857,
                source: 'only' as const,
                accounts: [{ account: 'atlas_lab', fairShareFactor: 0.142857 }],
            },
        });

        assert.equal(formatLeaderboardEntrySummary(withPartitions(['gpu-h100']), 96), '24 GPUs (25%) · FS 0.143 (gpu-h100)');
        // An account can run in several partitions on some clusters
        assert.equal(formatLeaderboardEntrySummary(withPartitions(['a100', 'h100', 'l40s']), 96), '24 GPUs (25%) · FS 0.143 (a100 +2)');
        // None known, e.g. a fair share account none of their GPU jobs run under
        assert.equal(formatLeaderboardEntrySummary(withPartitions([]), 96), '24 GPUs (25%) · FS 0.143');
    });

    it('lists the rest of a row in its dropdown', () => {
        assert.deepEqual(getLeaderboardEntryDetails({
            ...entry('mixed-user', 4, 2, ['a_inst', 'b_inst', 'c_inst']),
            gpuTypes: [{ type: 'a100', count: 3 }, { type: 'h100', count: 1 }],
        }), [
            { label: 'Accounts', value: 'a_inst, b_inst, c_inst', icon: 'organization' },
            { label: 'GPU jobs', value: '2', icon: 'play-circle' },
            { label: 'GPU types', value: 'a100: 3 GPUs, h100: 1 GPU', icon: 'circuit-board' },
        ]);
        assert.deepEqual(getLeaderboardEntryDetails(entry('solo', 1, 1, ['only_inst']))[0], {
            label: 'Account', value: 'only_inst', icon: 'organization',
        });
    });

    it('lists fair share in the dropdown for every account the user has, A to Z', () => {
        // Users can have many accounts (one per partition on some clusters); all are listed,
        // not only those their GPU jobs run under, so the picture is complete, in the same
        // order for everyone.
        const fairShareLine = getLeaderboardEntryDetails({
            ...entry('nova42', 8, 2, ['vision_lab']),
            fairShare: {
                username: 'nova42',
                account: 'vision_lab',
                fairShareFactor: 0.25,
                source: 'jobs' as const,
                accounts: [
                    { account: 'idle_lab', fairShareFactor: 0.9 },
                    { account: 'atlas_lab', fairShareFactor: 0.5 },
                    { account: 'vision_lab', fairShareFactor: 0.25 },
                ],
            },
        }).find(({ label }) => label === 'Fair share');

        assert.deepEqual(fairShareLine, {
            label: 'Fair share',
            icon: 'law',
            children: [
                { label: 'atlas_lab', value: '0.500' },
                { label: 'idle_lab', value: '0.900' },
                { label: 'vision_lab', value: '0.250' },
            ],
        });
    });

    it('leaves fair share out of the dropdown when the cluster reports none for the user', () => {
        assert.equal(getLeaderboardEntryDetails(entry('nova42', 8, 2)).find(({ label }) => label === 'Fair share'), undefined);
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

    it('keeps the tooltip to who and how much; the dropdown has the rest', () => {
        const tooltip = formatLeaderboardTooltipMarkdown({
            ...rankedEntry('mock-user', 1, false),
            accounts: ['mock_inst'],
            gpuCount: 6,
            gpuJobCount: 2,
            gpuTypes: [
                { type: 'a100', count: 4 },
                { type: 'h200', count: 2 },
            ],
            fairShare: {
                username: 'mock-user',
                account: 'mock_inst',
                fairShareFactor: 0.5,
                source: 'jobs' as const,
                accounts: [{ account: 'mock_inst', fairShareFactor: 0.5 }, { account: 'other_inst', fairShareFactor: 0.25 }],
            },
        }, 10);

        assert.equal(tooltip, [
            '**mock-user**',
            '',
            'Rank #1 · 6 GPUs · 2 GPU jobs',
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
