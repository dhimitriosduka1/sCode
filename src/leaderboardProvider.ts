import * as vscode from 'vscode';
import { SlurmService } from './slurmService';
import { buildFairShareLookup, getFairShareSummary } from './fairShareRanking';
import { showRefreshTime } from './leaderboardRefreshTime';
import { RefreshGate } from './refreshGate';
import {
    DEFAULT_LEADERBOARD_ENTRY_COUNT,
    formatLeaderboardEntrySummary,
    formatLeaderboardTooltipMarkdown,
    getGpuLeaderboardEntries,
    getLeaderboardEntryDetails,
    getLeaderboardEntryRowLabel,
    getLeaderboardEmojiIconSvg,
    getTotalLeaderboardGpuCount,
    getVisibleLeaderboardEntries,
    LeaderboardEntry,
    LeaderboardEntryDetail,
    normalizeLeaderboardEntryCount,
    RankedLeaderboardEntry,
} from './leaderboardRanking';

/**
 * A single user row in the Hall of Shame: who, their GPUs, share of the
 * cluster's GPUs in use and fair share, with the rest in its dropdown.
 */
class LeaderboardEntryItem extends vscode.TreeItem {
    constructor(
        readonly entry: RankedLeaderboardEntry,
        topUserCount: number,
        totalGpuCount: number,
    ) {
        super(getLeaderboardEntryRowLabel(entry), vscode.TreeItemCollapsibleState.Collapsed);
        // The top three's emoji; the rest have their rank in the label
        const emoji = getLeaderboardEmojiIconSvg(entry.rank);
        if (emoji) {
            this.iconPath = vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(emoji).toString('base64')}`);
        }
        this.description = formatLeaderboardEntrySummary(entry, totalGpuCount);
        this.contextValue = 'leaderboardEntry';
        this.tooltip = new vscode.MarkdownString(formatLeaderboardTooltipMarkdown(entry, topUserCount));
    }
}

/**
 * One line of a Hall of Shame row's dropdown, with the lines listed under it, if any.
 */
class LeaderboardDetailItem extends vscode.TreeItem {
    constructor(readonly detail: LeaderboardEntryDetail) {
        super(
            detail.value === undefined ? detail.label : `${detail.label}: ${detail.value}`,
            // Closed: fair share lists every account, a line per partition on some clusters
            detail.children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        this.iconPath = new vscode.ThemeIcon(detail.icon);
        this.contextValue = 'leaderboardDetail';
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


function isFairShareEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    return config.get<boolean>('showFairShare', true);
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
    // Disables the view's refresh button while it loads (package.json `enablement`)
    private readonly refreshGate = new RefreshGate<vscode.TreeItem[]>(
        () => this.reload(),
        (refreshing) => void vscode.commands.executeCommand('setContext', 'slurmLeaderboard.refreshing', refreshing),
    );
    private currentUsernameProvider: () => string | undefined;
    /** Shows when the data was fetched in its title bar */
    view: vscode.TreeView<vscode.TreeItem> | undefined;

    constructor(slurmService: SlurmService, currentUsernameProvider?: () => string | undefined) {
        this.slurmService = slurmService;
        // The service knows who the user is on the cluster commands run on
        this.currentUsernameProvider = currentUsernameProvider ?? (() => slurmService.getUsername());
    }

    /** Reloads the view, once the refresh in progress (if any) is done. */
    refresh(): void {
        this.refreshGate.refresh();
    }

    private reload(): void {
        this.cachedEntries = [];
        this.lastRefreshedAt = undefined;
        this.hasFetchedEntries = false;
        // A manual refresh should really re-query the cluster, not replay the
        // shared fair share cache.
        this.slurmService.invalidateFairShareCache();
        this._onDidChangeTreeData.fire();
    }

    rerender(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (element instanceof LeaderboardEntryItem) {
            return getLeaderboardEntryDetails(element.entry)
                .map(detail => new LeaderboardDetailItem(detail));
        }
        if (element instanceof LeaderboardDetailItem) {
            return (element.detail.children ?? []).map(({ label, value }) => {
                const item = new vscode.TreeItem(`${label}: ${value}`, vscode.TreeItemCollapsibleState.None);
                // Lines it up after the icon of the line above, not under it
                item.iconPath = new vscode.ThemeIcon('circle-small-filled');
                return item;
            });
        }
        if (element) {
            return [];
        }

        return this.refreshGate.load(async () => {
            const items = await this.getRootItems();
            showRefreshTime(this.view, this.lastRefreshedAt);
            return items;
        });
    }

    private async getRootItems(): Promise<vscode.TreeItem[]> {
        try {
            // Fetch data once until manual refresh, even when the result is empty.
            if (!this.hasFetchedEntries) {
                const [entries, fairShare] = await Promise.all([
                    this.slurmService.getClusterLeaderboard(),
                    isFairShareEnabled()
                        ? this.slurmService.getFairShare()
                        : Promise.resolve({ entries: [], available: false }),
                ]);

                const fairShareLookup = buildFairShareLookup(fairShare.entries);
                this.cachedEntries = entries.map(entry => ({
                    ...entry,
                    // The accounts their GPU jobs run under decide which standing applies
                    fairShare: getFairShareSummary(fairShareLookup, entry.username, { jobAccounts: entry.accounts }),
                }));
                this.lastRefreshedAt = new Date();
                this.hasFetchedEntries = true;
            }

            const items: vscode.TreeItem[] = [];
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
