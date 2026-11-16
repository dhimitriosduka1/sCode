import { generateProgressBar } from './slurmService';
import { FairShareSummary, formatFairShareFactor } from './fairShareRanking';
import { formatTooltipMarkdown } from './tooltipMarkdown';

export interface LeaderboardEntry {
    username: string;
    accounts: string[];
    gpuCount: number;
    gpuJobCount: number;
    gpuTypes: LeaderboardGpuType[];
    /** Fair share standing, when the cluster reports it. */
    fairShare?: FairShareSummary;
}

export interface LeaderboardGpuType {
    type: string;
    count: number;
}

export interface RankedLeaderboardEntry extends LeaderboardEntry {
    rank: number;
    isCurrentUser: boolean;
    isOutsideTopEntries: boolean;
}

export const DEFAULT_LEADERBOARD_ENTRY_COUNT = 10;
export const MIN_LEADERBOARD_ENTRY_COUNT = 1;
export const MAX_LEADERBOARD_ENTRY_COUNT = 100;

export interface LeaderboardEntryLabel {
    label: string;
    highlights?: [number, number][];
}

export function getGpuLeaderboardEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
    return entries.filter(entry => entry.gpuCount > 0 && entry.gpuJobCount > 0);
}

export function sortLeaderboardEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
    const sorted = [...entries];
    sorted.sort((a, b) => b.gpuCount - a.gpuCount || b.gpuJobCount - a.gpuJobCount || a.username.localeCompare(b.username));
    return sorted;
}

/**
 * A row's dimmed text: the GPUs a user holds and the fair share of the account
 * their GPU jobs run under, spelled out as "Your fair share" is in Active Jobs.
 */
export function formatLeaderboardEntrySummary(entry: LeaderboardEntry): string {
    const gpus = `${entry.gpuCount} GPU${entry.gpuCount === 1 ? '' : 's'}`;
    return entry.fairShare
        ? `${gpus} · fair share ${formatFairShareFactor(entry.fairShare.fairShareFactor)}`
        : gpus;
}

export interface LeaderboardEntryDetail {
    label: string;
    value?: string;
    /** Codicon id */
    icon: string;
    /** Lines listed under this one */
    children?: { label: string; value: string }[];
}

/** What a row's dropdown lists: everything about the user the row itself leaves out. */
export function getLeaderboardEntryDetails(entry: LeaderboardEntry, totalGpuCount: number): LeaderboardEntryDetail[] {
    const details: LeaderboardEntryDetail[] = [
        { label: entry.accounts.length === 1 ? 'Account' : 'Accounts', value: entry.accounts.join(', ') || 'Unknown', icon: 'organization' },
        { label: 'GPU jobs', value: String(entry.gpuJobCount), icon: 'play-circle' },
        { label: 'GPU types', value: formatLeaderboardGpuTypeLabel(entry.gpuTypes), icon: 'circuit-board' },
    ];

    const share = formatLeaderboardGpuShare(entry.gpuCount, totalGpuCount);
    if (share) {
        details.push({ label: 'Cluster share', value: share, icon: 'pie-chart' });
    }

    // Only the accounts their GPU jobs run under: users can have many (one per
    // partition on some clusters), and with one, the row already shows it.
    // The account the row shows comes first.
    const shown = entry.fairShare?.account;
    const inUse = (entry.fairShare?.accounts ?? [])
        .filter(({ account }) => entry.accounts.includes(account))
        .sort((a, b) => Number(b.account === shown) - Number(a.account === shown));
    if (inUse.length > 1) {
        details.push({
            label: 'Fair share',
            icon: 'law',
            children: inUse.map(({ account, fairShareFactor }) => ({ label: account, value: formatFairShareFactor(fairShareFactor) })),
        });
    }

    return details;
}

export function formatLeaderboardGpuTypeLabel(gpuTypes: LeaderboardGpuType[]): string {
    if (gpuTypes.length === 0) {
        return 'Unknown';
    }

    return gpuTypes
        .map(gpuType => `${gpuType.type}: ${gpuType.count} GPU${gpuType.count === 1 ? '' : 's'}`)
        .join(', ');
}

export function getTotalLeaderboardGpuCount(entries: LeaderboardEntry[]): number {
    return entries.reduce((total, entry) => total + entry.gpuCount, 0);
}

export function formatLeaderboardGpuShare(gpuCount: number, totalGpuCount: number): string {
    if (totalGpuCount <= 0) {
        return '';
    }

    const percentage = (gpuCount / totalGpuCount) * 100;
    const roundedPercentage = Math.max(0, Math.min(100, Math.round(percentage)));

    return generateProgressBar(roundedPercentage, 8);
}

/** Who and how much; the row's dropdown has the rest. */
export function formatLeaderboardTooltipMarkdown(
    entry: RankedLeaderboardEntry,
    topUserCount: number,
): string {
    const gpuLabel = entry.gpuCount === 1 ? 'GPU' : 'GPUs';
    const gpuJobLabel = entry.gpuJobCount === 1 ? 'GPU job' : 'GPU jobs';
    return formatTooltipMarkdown({
        title: entry.username,
        summary: `Rank #${entry.rank} · ${entry.gpuCount} ${gpuLabel} · ${entry.gpuJobCount} ${gpuJobLabel}`,
        note: entry.isCurrentUser && entry.isOutsideTopEntries
            ? `Your row is shown outside the configured top ${topUserCount}.`
            : undefined,
    });
}

export function normalizeLeaderboardEntryCount(value: unknown): number {
    const numericValue = typeof value === 'number' ? value : Number(value);

    if (!Number.isFinite(numericValue)) {
        return DEFAULT_LEADERBOARD_ENTRY_COUNT;
    }

    const wholeValue = Math.floor(numericValue);
    if (wholeValue < MIN_LEADERBOARD_ENTRY_COUNT) {
        return MIN_LEADERBOARD_ENTRY_COUNT;
    }

    if (wholeValue > MAX_LEADERBOARD_ENTRY_COUNT) {
        return MAX_LEADERBOARD_ENTRY_COUNT;
    }

    return wholeValue;
}

export function getVisibleLeaderboardEntries(
    entries: LeaderboardEntry[],
    currentUsername: string | undefined,
    maxEntries: number = DEFAULT_LEADERBOARD_ENTRY_COUNT,
): RankedLeaderboardEntry[] {
    const sorted = sortLeaderboardEntries(entries);
    const normalizedMaxEntries = normalizeLeaderboardEntryCount(maxEntries);
    const normalizedCurrentUsername = currentUsername?.trim().toLowerCase();

    const visible = sorted.slice(0, normalizedMaxEntries).map((entry, index) => ({
        ...entry,
        rank: index + 1,
        isCurrentUser: Boolean(normalizedCurrentUsername && entry.username.toLowerCase() === normalizedCurrentUsername),
        isOutsideTopEntries: false,
    }));

    if (!normalizedCurrentUsername) {
        return visible;
    }

    const currentUserIndex = sorted.findIndex(entry => entry.username.toLowerCase() === normalizedCurrentUsername);
    if (currentUserIndex < 0 || currentUserIndex < normalizedMaxEntries) {
        return visible;
    }

    const currentUserEntry = sorted[currentUserIndex];
    visible.push({
        ...currentUserEntry,
        rank: currentUserIndex + 1,
        isCurrentUser: true,
        isOutsideTopEntries: true,
    });

    return visible;
}

/** The titles of the users holding the most GPUs, ranks 1, 2 and 3 in order. */
const LEADERBOARD_TITLES = ['Node Nom-Nom', 'CUDA Cuddler', 'Batch Bandit'];

export function getLeaderboardEntryRowLabel(
    entry: RankedLeaderboardEntry,
): LeaderboardEntryLabel {
    const rankLabel = getLeaderboardRankLabel(entry.rank);
    const title = LEADERBOARD_TITLES[entry.rank - 1];
    const label = [rankLabel, title && `${title}:`, entry.username].filter(Boolean).join(' ');

    // The title is highlighted so it stands out, and so is the username on
    // your own row. The username ends the label; searching for it could land
    // inside the title.
    const highlights: [number, number][] = [];
    if (title) {
        highlights.push([rankLabel.length + 1, rankLabel.length + 1 + title.length]);
    }
    if (entry.isCurrentUser) {
        highlights.push([label.length - entry.username.length, label.length]);
    }
    return highlights.length > 0 ? { label, highlights } : { label };
}

function getLeaderboardRankLabel(rank: number): string {
    return rank === 1 ? '🦈' : rank === 2 ? '🐨' : rank === 3 ? '🐼' : `${rank}.`;
}
