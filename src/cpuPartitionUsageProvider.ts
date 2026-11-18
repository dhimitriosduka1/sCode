import * as vscode from 'vscode';
import { showRefreshTime } from './leaderboardRefreshTime';
import { createMaintenanceWarningItem } from './maintenanceWarningItem';
import { formatPartitionLoadDescription, formatPartitionLoadDocumentation, PartitionLoad } from './partitionCompletion';
import { PartitionDataStore } from './partitionDataStore';
import { formatPartitionUsageMemoryBreakdown, formatPartitionUsageNodeBreakdown } from './partitionUsageRanking';
import { generateProgressBar, MaintenanceWindow, PartitionUsageEntry, SlurmService } from './slurmService';

class CpuPartitionUsageItem extends vscode.TreeItem {
    constructor(readonly load: PartitionLoad, readonly entry: PartitionUsageEntry | undefined, rank: number) {
        super(`${rank}. ${load.partition}`, vscode.TreeItemCollapsibleState.Collapsed);
        const jobs = entry ? ` · ${entry.runningJobs}R/${entry.pendingJobs}PD` : '';
        this.description = `${formatPartitionLoadDescription(load)}${jobs} · ${generateProgressBar(Math.round(load.loadRatio * 100), 8)}`;
        this.iconPath = new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.blue'));
        this.contextValue = 'cpuPartitionUsageEntry';
        this.tooltip = new vscode.MarkdownString(formatPartitionLoadDocumentation(load));
    }
}

function detailItem(label: string, description: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label);
    item.description = description;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = 'partitionUsageDetail';
    return item;
}

function getDetailChildren(load: PartitionLoad, entry: PartitionUsageEntry | undefined): vscode.TreeItem[] {
    const cpus = load.cpuUsage!;
    const children = [detailItem('CPUs', `${cpus.allocatedCpus} allocated, ${cpus.idleCpus} idle, ${cpus.otherCpus} unavailable, ${cpus.totalCpus} total`, 'pulse')];
    if (!entry) {
        return children;
    }

    const memory = formatPartitionUsageMemoryBreakdown(entry);
    if (memory) {
        children.push(detailItem('Memory', memory, 'database'));
    }
    children.push(
        detailItem('Nodes', formatPartitionUsageNodeBreakdown(entry), 'server'),
        detailItem('Jobs', `${entry.runningJobs} running, ${entry.pendingJobs} pending`, 'play-circle'),
    );
    return children;
}

/**
 * TreeDataProvider for CPU-only partitions, the ones GPU Partition Usage leaves out.
 * Reads the shared partition snapshot, so it runs no Slurm command of its own besides maintenance.
 */
export class CpuPartitionUsageProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private cachedMaintenanceWindows: MaintenanceWindow[] = [];
    private hasFetchedMaintenance = false;
    private readonly unsubscribe: () => void;
    /** Shows when the data was fetched in its title bar */
    view: vscode.TreeView<vscode.TreeItem> | undefined;

    constructor(
        private readonly slurmService: SlurmService,
        private readonly store: PartitionDataStore,
    ) {
        this.unsubscribe = store.onDidChange(() => this._onDidChangeTreeData.fire());
    }

    /** Re-queries maintenance on the next render; partition data comes through the store. */
    refresh(): void {
        this.cachedMaintenanceWindows = [];
        this.hasFetchedMaintenance = false;
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.unsubscribe();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof CpuPartitionUsageItem) {
            return getDetailChildren(element.load, element.entry);
        }
        if (element) {
            return [];
        }

        try {
            const [snapshot] = await Promise.all([this.store.getSnapshot(), this.fetchMaintenanceOnce()]);

            const items: vscode.TreeItem[] = [];
            const maintenanceItem = createMaintenanceWarningItem(this.cachedMaintenanceWindows);
            if (maintenanceItem) {
                items.push(maintenanceItem);
            }

            showRefreshTime(this.view, snapshot.fetchedAt);

            // loads are already least occupied first within each resource group
            const cpuLoads = snapshot.loads.filter(load => load.resource === 'CPU');
            if (cpuLoads.length === 0) {
                const empty = new vscode.TreeItem('No CPU-only partitions found');
                empty.iconPath = new vscode.ThemeIcon('info');
                items.push(empty);
                return items;
            }

            const entries = new Map((snapshot.usage.cpuOnlyEntries ?? []).map(entry => [entry.partition, entry]));
            const pending = snapshot.usage.pendingCpuJobs;
            const summary = new vscode.TreeItem('CPU partitions');
            summary.description = `${pending} pending · ${cpuLoads.length} ${cpuLoads.length === 1 ? 'partition' : 'partitions'}`;
            summary.iconPath = new vscode.ThemeIcon('server-environment');
            items.push(summary);

            items.push(...cpuLoads.map((load, index) => new CpuPartitionUsageItem(load, entries.get(load.partition), index + 1)));
            return items;
        } catch (error) {
            console.error('Error fetching CPU Partition Usage:', error);
            showRefreshTime(this.view, undefined);
            const failed = new vscode.TreeItem('Failed to fetch CPU Partition Usage');
            failed.iconPath = new vscode.ThemeIcon('error');
            return [failed];
        }
    }

    private async fetchMaintenanceOnce(): Promise<void> {
        if (this.hasFetchedMaintenance) {
            return;
        }

        this.cachedMaintenanceWindows = await this.slurmService.getMaintenanceWindows();
        this.hasFetchedMaintenance = true;
    }
}
