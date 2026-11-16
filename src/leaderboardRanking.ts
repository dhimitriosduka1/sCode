import { generateProgressBar } from './slurmService';
import { FairShareSummary, formatFairShareFactor } from './fairShareRanking';
import { formatTooltipMarkdown } from './tooltipMarkdown';

export interface LeaderboardEntry {
    username: string;
    accounts: string[];
    /** The partitions each account runs the user's GPU jobs in */
    accountPartitions: Record<string, string[]>;
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
 * A row's dimmed text: the GPUs a user holds, their share of all GPUs in use,
 * and the fair share (FS, as sshare calls it) of the account their GPU jobs
 * run under, with the partition it runs them in: `24 GPUs (25%) · FS 0.420 (gpu-h100)`.
 */
export function formatLeaderboardEntrySummary(entry: LeaderboardEntry, totalGpuCount: number): string {
    const share = totalGpuCount > 0 ? ` (${getLeaderboardGpuSharePercent(entry.gpuCount, totalGpuCount)}%)` : '';
    const gpus = `${entry.gpuCount} GPU${entry.gpuCount === 1 ? '' : 's'}${share}`;
    if (!entry.fairShare) {
        return gpus;
    }

    // An account can run in several partitions on some clusters
    const [partition, ...others] = entry.accountPartitions[entry.fairShare.account] ?? [];
    const where = partition ? ` (${partition}${others.length > 0 ? ` +${others.length}` : ''})` : '';
    return `${gpus} · FS ${formatFairShareFactor(entry.fairShare.fairShareFactor)}${where}`;
}

export interface LeaderboardEntryDetail {
    label: string;
    value?: string;
    /** Codicon id */
    icon: string;
    /** Lines listed under this one */
    children?: { label: string; value: string }[];
}

/** What a row's dropdown lists: the user's accounts, GPU jobs and types, and the fair share of every account. */
export function getLeaderboardEntryDetails(entry: LeaderboardEntry): LeaderboardEntryDetail[] {
    const details: LeaderboardEntryDetail[] = [
        { label: entry.accounts.length === 1 ? 'Account' : 'Accounts', value: entry.accounts.join(', ') || 'Unknown', icon: 'organization' },
        { label: 'GPU jobs', value: String(entry.gpuJobCount), icon: 'play-circle' },
        { label: 'GPU types', value: formatLeaderboardGpuTypeLabel(entry.gpuTypes), icon: 'circuit-board' },
    ];

    // Every account the user has (one per partition on some clusters), not
    // only those their GPU jobs run under, A to Z so every list reads alike.
    if (entry.fairShare) {
        const accounts = [...entry.fairShare.accounts].sort((a, b) => a.account.localeCompare(b.account));
        details.push({
            label: 'Fair share',
            icon: 'law',
            children: accounts.map(({ account, fairShareFactor }) => ({ label: account, value: formatFairShareFactor(fairShareFactor) })),
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

    return generateProgressBar(getLeaderboardGpuSharePercent(gpuCount, totalGpuCount), 8);
}

function getLeaderboardGpuSharePercent(gpuCount: number, totalGpuCount: number): number {
    return Math.max(0, Math.min(100, Math.round((gpuCount / totalGpuCount) * 100)));
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
    // The top three's emoji is the row's icon
    const title = LEADERBOARD_TITLES[entry.rank - 1];
    const label = title ? `${title}: ${entry.username}` : `${entry.rank}. ${entry.username}`;

    // Your own username is highlighted. It ends the label; searching for it
    // could land inside the title.
    return entry.isCurrentUser
        ? { label, highlights: [[label.length - entry.username.length, label.length]] }
        : { label };
}

const LEADERBOARD_EMOJI = ['🦈', '🐨', '🐼'];

/**
 * The top three's emoji as a 16×16 icon. As an icon rather than in the label,
 * it gives the row the width that indents its dropdown, as in the other views.
 * The rest have no icon.
 */
export function getLeaderboardEmojiIconSvg(rank: number): string | undefined {
    const emoji = LEADERBOARD_EMOJI[rank - 1];
    return emoji
        && `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><text x="8" y="13.5" font-size="14" text-anchor="middle">${emoji}</text></svg>`;
}
