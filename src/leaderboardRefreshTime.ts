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
