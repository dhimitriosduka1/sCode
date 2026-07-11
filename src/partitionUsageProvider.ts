import * as vscode from 'vscode';
import { formatLeaderboardRefreshLabel, formatLeaderboardRefreshTooltip } from './leaderboardRefreshTime';
import { PartitionUsageEntry, PartitionUsageResult, SlurmService } from './slurmService';
import {
    formatPartitionUsageDescription,
    formatPartitionUsageGpuBreakdown,
    formatPartitionUsageNodeBreakdown,
    formatPartitionUsageSummary,
    formatPartitionUsageTooltipMarkdown,
    formatPartitionUsageTrailingDescription,
    getPartitionUsageLabel,
    sortPartitionUsageEntries,
} from './partitionUsageRanking';
import { formatLeaderboardGpuTypeLabel } from './leaderboardRanking';
import { formatTooltipMarkdown } from './tooltipMarkdown';

class PartitionUsageRefreshItem extends vscode.TreeItem {
    constructor(refreshedAt: Date) {
        super(formatLeaderboardRefreshLabel(refreshedAt), vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('history');
        this.contextValue = 'partitionUsageRefreshInfo';
        this.tooltip = new vscode.MarkdownString(formatLeaderboardRefreshTooltip(refreshedAt, {
            title: 'GPU Partition Usage refresh',
            refreshCommandLabel: 'Refresh GPU Partition Usage',
        }));
    }
}

class PartitionUsageSummaryItem extends vscode.TreeItem {
    constructor(result: PartitionUsageResult) {
        super('GPU partitions', vscode.TreeItemCollapsibleState.None);
        this.description = formatPartitionUsageSummary(result);
        this.iconPath = new vscode.ThemeIcon('server-environment');
        this.contextValue = 'partitionUsageSummary';
        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title: 'GPU Partition Usage',
            summary: formatPartitionUsageSummary(result),
            note: 'Rows are sorted from least used to most used by allocated GPU share, with pending jobs used as a tie-breaker.',
        }));
    }
}

class PartitionUsageItem extends vscode.TreeItem {
    readonly entry: PartitionUsageEntry;

    constructor(entry: PartitionUsageEntry, rank: number) {
        super(getPartitionUsageLabel(entry, rank), vscode.TreeItemCollapsibleState.Collapsed);
        this.entry = entry;
        this.description = `${formatPartitionUsageDescription(entry)} · ${formatPartitionUsageTrailingDescription(entry)}`;
        this.iconPath = getPartitionUsageIcon(entry);
        this.contextValue = 'partitionUsageEntry';
        this.tooltip = new vscode.MarkdownString(formatPartitionUsageTooltipMarkdown(entry));
    }
}

class PartitionUsageDetailItem extends vscode.TreeItem {
    constructor(label: string, description: string, icon: string, iconColor?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.iconPath = new vscode.ThemeIcon(icon, iconColor ? new vscode.ThemeColor(iconColor) : undefined);
        this.contextValue = 'partitionUsageDetail';
    }
}

class PartitionUsageMessageItem extends vscode.TreeItem {
    constructor(message: string, icon: string = 'info') {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

function getPartitionUsageIcon(entry: PartitionUsageEntry): vscode.ThemeIcon {
    if (entry.totalGpus > 0) {
        return new vscode.ThemeIcon('circuit-board', new vscode.ThemeColor('charts.purple'));
    }

    return new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.blue'));
}

function getPartitionDetailChildren(entry: PartitionUsageEntry): vscode.TreeItem[] {
    const children: vscode.TreeItem[] = [];

    children.push(new PartitionUsageDetailItem(
        'GPUs',
        formatPartitionUsageGpuBreakdown(entry),
        'chip',
    ));

    children.push(new PartitionUsageDetailItem(
        'Nodes',
        formatPartitionUsageNodeBreakdown(entry),
        'server',
    ));

    if (entry.gpuTypes.length > 0) {
        children.push(new PartitionUsageDetailItem(
            'GPU types',
            formatLeaderboardGpuTypeLabel(entry.gpuTypes),
            'tag',
        ));
    }

    children.push(new PartitionUsageDetailItem(
        'Jobs',
        `${entry.runningJobs} running, ${entry.pendingJobs} pending`,
        'play-circle',
    ));

    return children;
}

/**
 * TreeDataProvider for partition-level cluster usage.
 * Fetches once until manual refresh, matching the overview views.
 */
export class PartitionUsageProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private cachedResult: PartitionUsageResult | undefined;
    private lastRefreshedAt: Date | undefined;
    private hasFetchedEntries = false;

    constructor(private readonly slurmService: SlurmService) {}

    refresh(): void {
        this.cachedResult = undefined;
        this.lastRefreshedAt = undefined;
        this.hasFetchedEntries = false;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof PartitionUsageItem) {
            return getPartitionDetailChildren(element.entry);
        }

        if (element) {
            return [];
        }

        return this.getRootItems();
    }

    private async getRootItems(): Promise<vscode.TreeItem[]> {
        try {
            if (!this.hasFetchedEntries) {
                this.cachedResult = await this.slurmService.getPartitionUsage();
                this.lastRefreshedAt = new Date();
                this.hasFetchedEntries = true;
            }

            const items: vscode.TreeItem[] = [];
            if (this.lastRefreshedAt) {
                items.push(new PartitionUsageRefreshItem(this.lastRefreshedAt));
            }

            const entries = sortPartitionUsageEntries(this.cachedResult!.entries);
            if (entries.length === 0) {
                items.push(new PartitionUsageMessageItem('No GPU partition usage data available', 'info'));
                return items;
            }

            items.push(new PartitionUsageSummaryItem(this.cachedResult!));
            items.push(...entries.map((entry, index) => new PartitionUsageItem(entry, index + 1)));

            return items;
        } catch (error) {
            console.error('Error fetching GPU Partition Usage:', error);
            return [new PartitionUsageMessageItem('Failed to fetch GPU Partition Usage', 'error')];
        }
    }
}
