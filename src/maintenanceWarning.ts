import { formatStartTime, MaintenanceWindow } from './slurmService';
import { formatTooltipMarkdown } from './tooltipMarkdown';

export interface ActiveMaintenanceStatus {
    window: MaintenanceWindow;
    isActive: boolean;
}

/**
 * Picks the single most relevant maintenance window to warn about — the one
 * currently in progress, or otherwise the soonest upcoming one. Windows that
 * have already ended (or have an unparseable end time) are ignored.
 */
export function getMostRelevantMaintenanceWindow(
    windows: MaintenanceWindow[],
    now: Date = new Date(),
): ActiveMaintenanceStatus | undefined {
    const nowMs = now.getTime();

    const upcomingOrActive = windows
        .map(window => ({
            window,
            startMs: Date.parse(window.startTime),
            endMs: Date.parse(window.endTime),
        }))
        .filter(candidate => !isNaN(candidate.endMs) && candidate.endMs > nowMs)
        .sort((a, b) => a.startMs - b.startMs);

    if (upcomingOrActive.length === 0) {
        return undefined;
    }

    const next = upcomingOrActive[0];
    return {
        window: next.window,
        isActive: !isNaN(next.startMs) && next.startMs <= nowMs,
    };
}

export function formatMaintenanceWarningLabel(status: ActiveMaintenanceStatus, now: Date = new Date()): string {
    if (status.isActive) {
        return 'Cluster maintenance in progress';
    }

    const startMs = Date.parse(status.window.startTime);
    if (isNaN(startMs)) {
        return 'Cluster maintenance scheduled';
    }

    return `Cluster maintenance starts in ${formatRelativeDuration(startMs - now.getTime())}`;
}

export function formatMaintenanceWarningTooltip(status: ActiveMaintenanceStatus): string {
    const { window } = status;
    return formatTooltipMarkdown({
        title: 'Cluster Maintenance',
        summary: status.isActive
            ? 'Maintenance is currently in progress on this cluster.'
            : 'A maintenance window is scheduled on this cluster.',
        details: [
            { label: 'Reservation', value: window.name },
            { label: 'Nodes', value: window.nodes },
            { label: 'Starts', value: formatStartTime(window.startTime) },
            { label: 'Ends', value: formatStartTime(window.endTime) },
        ],
    });
}

function formatRelativeDuration(ms: number): string {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }
    if (hours > 0) {
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    return `${minutes}m`;
}
