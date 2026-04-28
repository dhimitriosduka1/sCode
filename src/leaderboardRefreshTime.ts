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
}

export function formatLeaderboardRefreshTooltip(
    refreshedAt: Date,
    options: RefreshTooltipOptions = {},
): string {
    const title = options.title ?? 'Hall of Shame refresh';
    const refreshCommandLabel = options.refreshCommandLabel ?? 'Refresh Hall of Shame';

    return formatTooltipMarkdown({
        title,
        details: [{ label: 'Fetched at', value: refreshedAt.toLocaleString() }],
        note: `Use ${refreshCommandLabel} to update it.`,
    });
}
