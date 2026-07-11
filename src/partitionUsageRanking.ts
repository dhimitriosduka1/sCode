import { generateProgressBar, PartitionUsageEntry, PartitionUsageResult } from './slurmService';
import { formatLeaderboardGpuTypeLabel } from './leaderboardRanking';
import { formatTooltipMarkdown } from './tooltipMarkdown';

export function sortPartitionUsageEntries(entries: PartitionUsageEntry[]): PartitionUsageEntry[] {
    return [...entries].sort((a, b) =>
        getPartitionUsageRatio(a) - getPartitionUsageRatio(b) ||
        a.pendingJobs - b.pendingJobs ||
        b.idleGpus - a.idleGpus ||
        b.idleNodes - a.idleNodes ||
        a.runningJobs - b.runningJobs ||
        a.partition.localeCompare(b.partition)
    );
}

export function getPartitionUsageLabel(entry: PartitionUsageEntry, rank: number): string {
    return `${rank}. ${entry.partition}${entry.isDefault ? ' (default)' : ''}`;
}

export function formatPartitionUsageDescription(entry: PartitionUsageEntry): string {
    const runningPending = `${entry.runningJobs}R/${entry.pendingJobs}PD`;
    return `${entry.allocatedGpus}/${entry.availableGpus} GPUs · ${entry.idleGpus} idle · ${runningPending}`;
}

export function formatPartitionUsageTrailingDescription(entry: PartitionUsageEntry): string {
    return generateProgressBar(Math.round(getPartitionUsageRatio(entry) * 100), 8);
}

export function formatPartitionUsageGpuBreakdown(entry: PartitionUsageEntry): string {
    return `${entry.allocatedGpus} allocated, ${entry.idleGpus} idle, ${entry.availableGpus} available, ${entry.totalGpus} total`;
}

export function formatPartitionUsageNodeBreakdown(entry: PartitionUsageEntry): string {
    return `${entry.allocatedNodes} allocated, ${entry.idleNodes} idle, ${entry.otherNodes} other, ${entry.totalNodes} total`;
}

export function formatPartitionUsageTooltipMarkdown(entry: PartitionUsageEntry): string {
    const loadPercent = Math.round(getPartitionUsageRatio(entry) * 100);
    const details = [
        { label: 'Default partition', value: entry.isDefault ? 'Yes' : 'No' },
        { label: 'Load', value: `${loadPercent}%` },
        { label: 'Running jobs', value: entry.runningJobs },
        { label: 'Pending jobs', value: entry.pendingJobs },
        { label: 'Nodes', value: formatPartitionUsageNodeBreakdown(entry) },
    ];

    details.splice(2, 0,
        { label: 'GPUs', value: formatPartitionUsageGpuBreakdown(entry) },
        { label: 'GPU types', value: formatLeaderboardGpuTypeLabel(entry.gpuTypes) },
    );

    return formatTooltipMarkdown({
        title: entry.partition,
        summary: formatPartitionUsageDescription(entry),
        details,
    });
}

export function formatPartitionUsageSummary(result: PartitionUsageResult): string {
    const totalPartitions = result.entries.length;
    const partitionLabel = totalPartitions === 1 ? 'partition' : 'partitions';
    const totalPendingJobs = result.entries.reduce((total, entry) => total + entry.pendingJobs, 0);

    return `${result.clusterAllocatedGpus}/${result.clusterAvailableGpus} GPUs allocated · ${totalPendingJobs} pending · ${totalPartitions} ${partitionLabel}`;
}

function getPartitionUsageRatio(entry: PartitionUsageEntry): number {
    const capacity = getPartitionCapacity(entry);
    if (capacity <= 0) {
        return 1;
    }

    return Math.max(0, Math.min(1, entry.allocatedGpus / capacity));
}

function getPartitionCapacity(entry: PartitionUsageEntry): number {
    return entry.availableGpus;
}
