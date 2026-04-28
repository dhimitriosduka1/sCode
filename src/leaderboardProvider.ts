import * as vscode from 'vscode';
import * as os from 'os';
import { SlurmService } from './slurmService';
import { formatLeaderboardRefreshLabel, formatLeaderboardRefreshTooltip } from './leaderboardRefreshTime';
import {
    DEFAULT_LEADERBOARD_ENTRY_COUNT,
    formatLeaderboardEntryTrailingDescription,
    formatLeaderboardTooltipMarkdown,
    getGpuLeaderboardEntries,
    getLeaderboardEntryRowLabel,
    getTotalLeaderboardGpuCount,
    getVisibleLeaderboardEntries,
    LeaderboardEntry,
    normalizeLeaderboardEntryCount,
    RankedLeaderboardEntry,
} from './leaderboardRanking';

/**
 * A single user row in the Hall of Shame.
 */
class LeaderboardEntryItem extends vscode.TreeItem {
    constructor(
        entry: RankedLeaderboardEntry,
        topUserCount: number,
        totalGpuCount: number,
    ) {
        super(getLeaderboardEntryRowLabel(entry), vscode.TreeItemCollapsibleState.None);
        this.description = formatLeaderboardEntryTrailingDescription(entry, totalGpuCount);
        this.contextValue = 'leaderboardEntry';
        this.tooltip = new vscode.MarkdownString(formatLeaderboardTooltipMarkdown(entry, topUserCount));
    }
}

/**
 * Message item for empty states
 */
class LeaderboardMessageItem extends vscode.TreeItem {
    constructor(message: string, icon: string = 'info') {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

/**
 * Informational item showing when the Hall of Shame data was fetched.
 */
class LeaderboardRefreshItem extends vscode.TreeItem {
    constructor(refreshedAt: Date) {
        super(formatLeaderboardRefreshLabel(refreshedAt), vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('history');
        this.contextValue = 'leaderboardRefreshInfo';
        this.tooltip = new vscode.MarkdownString(formatLeaderboardRefreshTooltip(refreshedAt));
    }
}

function getCurrentUsername(): string | undefined {
    try {
        return os.userInfo().username || undefined;
    } catch {
        return process.env.USER || process.env.USERNAME;
    }
}

function getConfiguredTopUserCount(): number {
    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    return normalizeLeaderboardEntryCount(config.get<number>('leaderboardTopUserCount', DEFAULT_LEADERBOARD_ENTRY_COUNT));
}

/**
 * TreeDataProvider for the "Hall of Shame" cluster leaderboard.
 * Only fetches data on manual refresh or when the view is opened — no auto-refresh.
 */
export class LeaderboardProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private slurmService: SlurmService;
    private cachedEntries: LeaderboardEntry[] = [];
    private lastRefreshedAt: Date | undefined;
    private hasFetchedEntries = false;
    private currentUsernameProvider: () => string | undefined;

    constructor(slurmService: SlurmService, currentUsernameProvider: () => string | undefined = getCurrentUsername) {
        this.slurmService = slurmService;
        this.currentUsernameProvider = currentUsernameProvider;
    }

    refresh(): void {
        this.cachedEntries = [];
        this.lastRefreshedAt = undefined;
        this.hasFetchedEntries = false;
        this._onDidChangeTreeData.fire();
    }

    rerender(): void {
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
            // Fetch data once until manual refresh, even when the result is empty.
            if (!this.hasFetchedEntries) {
                this.cachedEntries = await this.slurmService.getClusterLeaderboard();
                this.lastRefreshedAt = new Date();
                this.hasFetchedEntries = true;
            }

            const items: vscode.TreeItem[] = [];
            if (this.lastRefreshedAt) {
                items.push(new LeaderboardRefreshItem(this.lastRefreshedAt));
            }

            const gpuEntries = getGpuLeaderboardEntries(this.cachedEntries);
            const totalGpuCount = getTotalLeaderboardGpuCount(gpuEntries);
            const topUserCount = getConfiguredTopUserCount();

            if (gpuEntries.length === 0) {
                items.push(new LeaderboardMessageItem('No GPU jobs running on the cluster', 'info'));
                return items;
            }

            const visibleEntries = getVisibleLeaderboardEntries(
                gpuEntries,
                this.currentUsernameProvider(),
                topUserCount,
            );
            items.push(...visibleEntries.map(entry => new LeaderboardEntryItem(entry, topUserCount, totalGpuCount)));

            return items;
        } catch (error) {
            console.error('Error fetching Hall of Shame:', error);
            return [new LeaderboardMessageItem('Failed to fetch Hall of Shame', 'error')];
        }
    }
}
