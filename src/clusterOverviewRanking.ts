import { ClusterAccountOverviewEntry, ClusterAccountOverviewUser } from './slurmService';
import { formatLeaderboardGpuShare, formatLeaderboardGpuTypeLabel } from './leaderboardRanking';
import { formatTooltipMarkdown } from './tooltipMarkdown';

export function sortClusterAccountOverviewEntries(
    entries: ClusterAccountOverviewEntry[],
): ClusterAccountOverviewEntry[] {
    return [...entries].sort((a, b) =>
        b.gpuCount - a.gpuCount ||
        b.gpuJobCount - a.gpuJobCount ||
        a.account.localeCompare(b.account)
    );
}

export function getTotalClusterOverviewGpuCount(entries: ClusterAccountOverviewEntry[]): number {
    return entries.reduce((total, entry) => total + entry.gpuCount, 0);
}

export function getClusterAccountOverviewLabel(entry: ClusterAccountOverviewEntry, rank: number): string {
    return `${rank}. ${entry.account}`;
}

export function formatClusterAccountOverviewDescription(entry: ClusterAccountOverviewEntry): string {
    return `${formatGpuCount(entry.gpuCount)} · ${formatGpuJobCount(entry.gpuJobCount)}`;
}

export function formatClusterAccountOverviewTrailingDescription(
    entry: ClusterAccountOverviewEntry,
    totalGpuCount: number,
): string {
    return formatLeaderboardGpuShare(entry.gpuCount, totalGpuCount);
}

export function formatClusterAccountOverviewTooltipMarkdown(
    entry: ClusterAccountOverviewEntry,
    totalGpuCount: number,
): string {
    return formatTooltipMarkdown({
        title: entry.account,
        summary: `${formatGpuCount(entry.gpuCount)} · ${formatGpuJobCount(entry.gpuJobCount)}`,
        details: [
            { label: 'Cluster GPU share', value: formatClusterGpuShareValue(entry.gpuCount, totalGpuCount) },
            { label: 'GPU types', value: formatLeaderboardGpuTypeLabel(entry.gpuTypes) },
        ],
        sections: [{
            title: 'Top users',
            lines: formatTopUserLines(entry.users),
        }],
    });
}

export function formatClusterGpuShareValue(gpuCount: number, totalGpuCount: number): string {
    if (totalGpuCount <= 0) {
        return `${formatGpuCount(gpuCount)} of 0 GPUs`;
    }

    const percentage = Math.max(0, Math.min(100, Math.round((gpuCount / totalGpuCount) * 100)));
    return `${formatGpuCount(gpuCount)} of ${formatGpuCount(totalGpuCount)} (${percentage}%)`;
}

function formatTopUserLines(users: ClusterAccountOverviewUser[]): string[] {
    const visibleUsers = [...users]
        .sort((a, b) => b.gpuCount - a.gpuCount || b.gpuJobCount - a.gpuJobCount || a.username.localeCompare(b.username))
        .slice(0, 5);

    return visibleUsers.map(user =>
        `${user.username}: ${formatGpuCount(user.gpuCount)} · ${formatGpuJobCount(user.gpuJobCount)}`
    );
}

function formatGpuCount(gpuCount: number): string {
    return `${gpuCount} GPU${gpuCount === 1 ? '' : 's'}`;
}

function formatGpuJobCount(gpuJobCount: number): string {
    return `${gpuJobCount} GPU job${gpuJobCount === 1 ? '' : 's'}`;
}
