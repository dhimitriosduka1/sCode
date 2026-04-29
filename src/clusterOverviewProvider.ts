import * as vscode from 'vscode';
import { formatLeaderboardRefreshLabel, formatLeaderboardRefreshTooltip } from './leaderboardRefreshTime';
import { ClusterAccountOverviewEntry, SlurmService } from './slurmService';
import {
    formatClusterAccountOverviewDescription,
    formatClusterAccountOverviewTooltipMarkdown,
    formatClusterAccountOverviewTrailingDescription,
    getClusterAccountOverviewLabel,
    getTotalClusterOverviewGpuCount,
    sortClusterAccountOverviewEntries,
} from './clusterOverviewRanking';
import { formatTooltipMarkdown } from './tooltipMarkdown';
import { SlurmConnectionSetupItem } from './connectionTreeItem';

class ClusterOverviewRefreshItem extends vscode.TreeItem {
    constructor(refreshedAt: Date) {
        super(formatLeaderboardRefreshLabel(refreshedAt), vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('history');
        this.contextValue = 'clusterOverviewRefreshInfo';
        this.tooltip = new vscode.MarkdownString(formatLeaderboardRefreshTooltip(refreshedAt, {
            title: 'Cluster Overview refresh',
            refreshCommandLabel: 'Refresh Cluster Overview',
        }));
    }
}

class ClusterOverviewTotalItem extends vscode.TreeItem {
    constructor(entries: ClusterAccountOverviewEntry[], totalGpuCount: number) {
        super(`Total GPUs in use: ${totalGpuCount}`, vscode.TreeItemCollapsibleState.None);
        this.description = `${entries.length} account${entries.length === 1 ? '' : 's'}`;
        this.iconPath = new vscode.ThemeIcon('dashboard');
        this.contextValue = 'clusterOverviewTotal';
        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title: 'Cluster Overview',
            summary: `${totalGpuCount} GPU${totalGpuCount === 1 ? '' : 's'} in use across ${entries.length} Slurm account${entries.length === 1 ? '' : 's'}.`,
        }));
    }
}

class ClusterOverviewAccountItem extends vscode.TreeItem {
    constructor(
        entry: ClusterAccountOverviewEntry,
        rank: number,
        totalGpuCount: number,
    ) {
        super(getClusterAccountOverviewLabel(entry, rank), vscode.TreeItemCollapsibleState.None);
        this.description = `${formatClusterAccountOverviewDescription(entry)} · ${formatClusterAccountOverviewTrailingDescription(entry, totalGpuCount)}`;
        this.contextValue = 'clusterOverviewAccount';
        this.tooltip = new vscode.MarkdownString(formatClusterAccountOverviewTooltipMarkdown(entry, totalGpuCount));
    }
}

class ClusterOverviewMessageItem extends vscode.TreeItem {
    constructor(message: string, icon: string = 'info') {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

/**
 * TreeDataProvider for account-level GPU usage across the cluster.
 * Fetches once until manual refresh, mirroring the Hall of Shame behavior.
 */
export class ClusterOverviewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private cachedEntries: ClusterAccountOverviewEntry[] = [];
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
            const availability = await this.slurmService.getAvailabilityStatus();
            if (!availability.available) {
                return [new SlurmConnectionSetupItem(availability)];
            }

            if (!this.hasFetchedEntries) {
                this.cachedEntries = await this.slurmService.getClusterAccountOverview();
                this.lastRefreshedAt = new Date();
                this.hasFetchedEntries = true;
            }

            const items: vscode.TreeItem[] = [];
            if (this.lastRefreshedAt) {
                items.push(new ClusterOverviewRefreshItem(this.lastRefreshedAt));
            }

            const entries = sortClusterAccountOverviewEntries(this.cachedEntries);
            const totalGpuCount = getTotalClusterOverviewGpuCount(entries);

            if (entries.length === 0) {
                items.push(new ClusterOverviewMessageItem('No GPU jobs running on the cluster', 'info'));
                return items;
            }

            items.push(new ClusterOverviewTotalItem(entries, totalGpuCount));
            items.push(...entries.map((entry, index) =>
                new ClusterOverviewAccountItem(entry, index + 1, totalGpuCount)
            ));

            return items;
        } catch (error) {
            console.error('Error fetching Cluster Overview:', error);
            return [new ClusterOverviewMessageItem('Failed to fetch Cluster Overview', 'error')];
        }
    }
}
