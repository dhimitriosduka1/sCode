import { formatTooltipMarkdown } from './tooltipMarkdown';

export function formatLeaderboardRefreshLabel(refreshedAt: Date, now: Date = new Date()): string {
    const isToday = refreshedAt.toDateString() === now.toDateString();
    const time = refreshedAt.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });

    if (isToday) {
        return `Last refreshed: ${time}`;
    }

    const date = refreshedAt.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
    });
    return `Last refreshed: ${date}, ${time}`;
}

export interface RefreshTooltipOptions {
    title?: string;
    refreshCommandLabel?: string;
    /** Background refresh interval; omitted for views that only refresh manually, 0 when turned off */
    autoRefreshMinutes?: number;
}

export function formatLeaderboardRefreshTooltip(
    refreshedAt: Date,
    options: RefreshTooltipOptions = {},
): string {
    const title = options.title ?? 'Hall of Shame refresh';
    const refreshCommandLabel = options.refreshCommandLabel ?? 'Refresh Hall of Shame';
    const details = [{ label: 'Fetched at', value: refreshedAt.toLocaleString() }];
    if (options.autoRefreshMinutes !== undefined) {
        details.push({
            label: 'Auto-refresh',
            value: options.autoRefreshMinutes > 0
                ? `every ${options.autoRefreshMinutes} min`
                : 'off',
        });
    }

    return formatTooltipMarkdown({
        title,
        details,
        note: options.autoRefreshMinutes
            ? `Use ${refreshCommandLabel} to update it now.`
            : `Use ${refreshCommandLabel} to update it.`,
    });
}

/** How old fetched data is, at a glance: "just now", "4 min ago", "2 h ago", or the date once it's from another day. */
export function formatDataAge(fetchedAt: Date, now: Date = new Date()): string {
    const minutes = Math.floor((now.getTime() - fetchedAt.getTime()) / 60000);
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    if (fetchedAt.toDateString() === now.toDateString()) {
        return `${Math.floor(minutes / 60)} h ago`;
    }
    return `on ${fetchedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/**
 * The first line of panels showing cached partition data: its age, and a
 * refresh button with the same icon as the GPU Partition Usage toolbar.
 * Rendered as trusted markdown with theme icons.
 */
export function formatPartitionDataFreshness(fetchedAt: Date, now: Date = new Date()): string {
    return `Updated ${formatDataAge(fetchedAt, now)} &nbsp; [$(refresh)](command:${PARTITION_REFRESH_COMMAND} "Refresh partition data")`;
}

/** Puts the freshness line above a panel's details, as every panel showing cached partition data does. */
export function withPartitionDataFreshness(details: string, fetchedAt: Date, now: Date = new Date()): string {
    return `${formatPartitionDataFreshness(fetchedAt, now)}\n\n---\n\n${details}`;
}

/** The command the freshness line's refresh button runs; the only command those panels may invoke. */
export const PARTITION_REFRESH_COMMAND = 'slurmPartitionUsage.refresh';
