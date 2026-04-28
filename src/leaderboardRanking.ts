import { generateProgressBar } from './slurmService';
import { formatTooltipMarkdown } from './tooltipMarkdown';

export interface LeaderboardEntry {
    username: string;
    accounts: string[];
    gpuCount: number;
    gpuJobCount: number;
    gpuTypes: LeaderboardGpuType[];
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

export function formatLeaderboardEntryDescription(entry: LeaderboardEntry): string {
    const accountLabel = formatLeaderboardAccountLabel(entry.accounts);
    const usageLabel = `${entry.gpuCount} GPUs · ${entry.gpuJobCount} GPU job${entry.gpuJobCount === 1 ? '' : 's'}`;
    return accountLabel ? `${accountLabel} · ${usageLabel}` : usageLabel;
}

export function formatLeaderboardEntryRowDescription(entry: LeaderboardEntry, totalGpuCount: number): string {
    const baseDescription = formatLeaderboardEntryDescription(entry);
    const gpuShare = formatLeaderboardGpuShare(entry.gpuCount, totalGpuCount);
    return gpuShare ? `${baseDescription} · ${gpuShare}` : baseDescription;
}

export function formatLeaderboardEntryTrailingDescription(
    entry: LeaderboardEntry,
    totalGpuCount: number,
): string {
    return formatLeaderboardGpuShare(entry.gpuCount, totalGpuCount);
}

export function formatLeaderboardAccountLabel(accounts: string[]): string {
    if (accounts.length === 0) {
        return '';
    }

    if (accounts.length <= 2) {
        return accounts.join(', ');
    }

    return `${accounts[0]}, ${accounts[1]} +${accounts.length - 2}`;
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

export function formatLeaderboardTooltipMarkdown(
    entry: RankedLeaderboardEntry,
    topUserCount: number,
): string {
    const gpuLabel = entry.gpuCount === 1 ? 'GPU' : 'GPUs';
    const gpuJobLabel = entry.gpuJobCount === 1 ? 'GPU job' : 'GPU jobs';
    const accountLabel = formatLeaderboardAccountLabel(entry.accounts) || 'Unknown';
    return formatTooltipMarkdown({
        title: entry.username,
        summary: `Rank #${entry.rank} · ${entry.gpuCount} ${gpuLabel} · ${entry.gpuJobCount} ${gpuJobLabel}`,
        details: [
            { label: `Slurm account${entry.accounts.length === 1 ? '' : 's'}`, value: accountLabel },
            { label: 'GPU types', value: formatLeaderboardGpuTypeLabel(entry.gpuTypes) },
        ],
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

export function getLeaderboardEntryLabel(entry: RankedLeaderboardEntry): LeaderboardEntryLabel {
    const label = `${getLeaderboardRankLabel(entry.rank)} ${entry.username}`;

    return highlightCurrentUsername(label, entry);
}

export function getLeaderboardEntryRowLabel(
    entry: RankedLeaderboardEntry,
): LeaderboardEntryLabel {
    const prefix = `${getLeaderboardRankLabel(entry.rank)} ${entry.username}`;
    const description = formatLeaderboardEntryDescription(entry);
    const label = description ? `${prefix} ${description}` : prefix;

    return highlightCurrentUsername(label, entry);
}

function getLeaderboardRankLabel(rank: number): string {
    return rank === 1 ? '💀' : rank === 2 ? '🔥' : rank === 3 ? '👹' : `${rank}.`;
}

function highlightCurrentUsername(
    label: string,
    entry: RankedLeaderboardEntry,
): LeaderboardEntryLabel {
    if (!entry.isCurrentUser) {
        return { label };
    }

    const usernameStart = label.indexOf(entry.username);
    return {
        label,
        highlights: usernameStart >= 0
            ? [[usernameStart, usernameStart + entry.username.length]]
            : undefined,
    };
}
