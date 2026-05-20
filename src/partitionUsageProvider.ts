import * as vscode from 'vscode';
import { formatLeaderboardRefreshLabel, formatLeaderboardRefreshTooltip } from './leaderboardRefreshTime';
import { PartitionUsageEntry, SlurmService } from './slurmService';
import {
    formatPartitionUsageDescription,
    formatPartitionUsageSummary,
    formatPartitionUsageTooltipMarkdown,
    formatPartitionUsageTrailingDescription,
    getPartitionUsageLabel,
    sortPartitionUsageEntries,
} from './partitionUsageRanking';
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
    constructor(entries: PartitionUsageEntry[]) {
        super('GPU partitions', vscode.TreeItemCollapsibleState.None);
        this.description = formatPartitionUsageSummary(entries);
        this.iconPath = new vscode.ThemeIcon('server-environment');
        this.contextValue = 'partitionUsageSummary';
        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title: 'GPU Partition Usage',
            summary: formatPartitionUsageSummary(entries),
            note: 'Rows are sorted from least used to most used by allocated GPU share, with pending jobs used as a tie-breaker.',
        }));
    }
}

class PartitionUsageItem extends vscode.TreeItem {
    constructor(entry: PartitionUsageEntry, rank: number) {
        super(getPartitionUsageLabel(entry, rank), vscode.TreeItemCollapsibleState.None);
        this.description = `${formatPartitionUsageDescription(entry)} · ${formatPartitionUsageTrailingDescription(entry)}`;
        this.iconPath = getPartitionUsageIcon(entry);
        this.contextValue = 'partitionUsageEntry';
        this.tooltip = new vscode.MarkdownString(formatPartitionUsageTooltipMarkdown(entry));
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

/**
 * TreeDataProvider for partition-level cluster usage.
 * Fetches once until manual refresh, matching the overview views.
 */
export class PartitionUsageProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private cachedEntries: PartitionUsageEntry[] = [];
    private lastRefreshedAt: Date | undefined;
    private hasFetchedEntries = false;

    constructor(private readonly slurmService: SlurmService) {}

    refresh(): void {
        this.cachedEntries = [];
        this.lastRefreshedAt = undefined;
        this.hasFetchedEntries = false;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element) {
            return [];
        }

        return this.getRootItems();
    }

    private async getRootItems(): Promise<vscode.TreeItem[]> {
        try {
            const isAvailable = await this.slurmService.isAvailable();
            if (!isAvailable) {
                const items: vscode.TreeItem[] = [];
                if (this.slurmService.isRemoteMode()) {
                    items.push(new PartitionUsageMessageItem(`SSH connection failed or SLURM not available on '${this.slurmService.getRemoteHost()}'`, 'warning'));
                    
                    const troubleshootItem = new vscode.TreeItem('Troubleshoot Connection...', vscode.TreeItemCollapsibleState.None);
                    troubleshootItem.iconPath = new vscode.ThemeIcon('wrench');
                    troubleshootItem.command = {
                        command: 'slurmJobs.troubleshootConnection',
                        title: 'Troubleshoot Connection...'
                    };
                    items.push(troubleshootItem);

                    const configureItem = new vscode.TreeItem('Configure SSH Settings...', vscode.TreeItemCollapsibleState.None);
                    configureItem.iconPath = new vscode.ThemeIcon('settings-gear');
                    configureItem.command = {
                        command: 'slurmJobs.setupRemoteSSH',
                        title: 'Configure SSH Settings...'
                    };
                    items.push(configureItem);
                } else {
                    items.push(new PartitionUsageMessageItem('SLURM not available on this system', 'warning'));
                }
                return items;
            }

            if (!this.hasFetchedEntries) {
                this.cachedEntries = await this.slurmService.getPartitionUsage();
                this.lastRefreshedAt = new Date();
                this.hasFetchedEntries = true;
            }

            const items: vscode.TreeItem[] = [];
            if (this.lastRefreshedAt) {
                items.push(new PartitionUsageRefreshItem(this.lastRefreshedAt));
            }

            const entries = sortPartitionUsageEntries(this.cachedEntries);
            if (entries.length === 0) {
                items.push(new PartitionUsageMessageItem('No GPU partition usage data available', 'info'));
                return items;
            }

            items.push(new PartitionUsageSummaryItem(entries));
            items.push(...entries.map((entry, index) => new PartitionUsageItem(entry, index + 1)));

            return items;
        } catch (error) {
            console.error('Error fetching GPU Partition Usage:', error);
            return [new PartitionUsageMessageItem('Failed to fetch GPU Partition Usage', 'error')];
        }
    }
}
