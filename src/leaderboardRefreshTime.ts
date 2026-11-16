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

/**
 * Shows when a view's data was fetched in its title bar, after the view's
 * name; clears it when there is no data. As a row it would sit after an empty
 * gap in views whose rows expand, which VS Code leaves before rows that don't.
 */
export function showRefreshTime(view: { description?: string } | undefined, refreshedAt: Date | undefined): void {
    if (view) {
        view.description = refreshedAt && formatLeaderboardRefreshLabel(refreshedAt);
    }
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
