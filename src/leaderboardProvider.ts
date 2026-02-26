import * as vscode from 'vscode';
import { SlurmService } from './slurmService';

/**
 * Leaderboard entry for a single user
 */
interface LeaderboardEntry {
    username: string;
    jobCount: number;
    gpuCount: number;
}

/**
 * Category item: "GPU Leaderboard" or "Job Leaderboard"
 */
class LeaderboardCategoryItem extends vscode.TreeItem {
    constructor(
        public readonly mode: 'gpu' | 'jobs',
        public readonly entries: LeaderboardEntry[],
    ) {
        const label = mode === 'gpu' ? '⚡ GPU Leaderboard' : '🏃 Job Leaderboard';
        super(label, entries.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed
        );
        this.contextValue = 'leaderboardCategory';
        this.description = `(${entries.length} users)`;
    }
}

/**
 * A single user row in the leaderboard
 */
class LeaderboardEntryItem extends vscode.TreeItem {
    constructor(
        entry: LeaderboardEntry,
        rank: number,
        mode: 'gpu' | 'jobs',
    ) {
        const medal = rank === 1 ? '💀' : rank === 2 ? '🔥' : rank === 3 ? '👹' : `${rank}.`;
        const primary = mode === 'gpu'
            ? `${entry.gpuCount} GPUs`
            : `${entry.jobCount} jobs`;
        const secondary = mode === 'gpu'
            ? `${entry.jobCount} jobs`
            : `${entry.gpuCount} GPUs`;

        super(`${medal} ${entry.username}`, vscode.TreeItemCollapsibleState.None);
        this.description = `${primary} · ${secondary}`;
        this.contextValue = 'leaderboardEntry';

        // Fun tooltip
        const tooltipLines = [
            `**${entry.username}**`,
            ``,
            `| Metric | Value |`,
            `|--------|-------|`,
            `| Running Jobs | ${entry.jobCount} |`,
            `| GPUs Allocated | ${entry.gpuCount} |`,
            `| Rank (${mode === 'gpu' ? 'GPU' : 'Jobs'}) | #${rank} |`,
        ];
        const md = new vscode.MarkdownString(tooltipLines.join('\n'));
        this.tooltip = md;
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

const MAX_ENTRIES = 10;

/**
 * TreeDataProvider for the "Hall of Flame" cluster leaderboard.
 * Only fetches data on manual refresh or when the view is opened — no auto-refresh.
 */
export class LeaderboardProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private slurmService: SlurmService;
    private cachedEntries: LeaderboardEntry[] = [];

    constructor(slurmService: SlurmService) {
        this.slurmService = slurmService;
    }

    refresh(): void {
        this.cachedEntries = [];
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        // Category children — show ranked entries
        if (element instanceof LeaderboardCategoryItem) {
            const sorted = [...element.entries];
            if (element.mode === 'gpu') {
                sorted.sort((a, b) => b.gpuCount - a.gpuCount || b.jobCount - a.jobCount);
            } else {
                sorted.sort((a, b) => b.jobCount - a.jobCount || b.gpuCount - a.gpuCount);
            }
            const top = sorted.slice(0, MAX_ENTRIES);
            return top.map((entry, i) => new LeaderboardEntryItem(entry, i + 1, element.mode));
        }

        // Root level
        return this.getRootItems();
    }

    private async getRootItems(): Promise<vscode.TreeItem[]> {
        try {
            // Fetch fresh data if cache is empty
            if (this.cachedEntries.length === 0) {
                this.cachedEntries = await this.slurmService.getClusterLeaderboard();
            }

            if (this.cachedEntries.length === 0) {
                return [new LeaderboardMessageItem('No running jobs on the cluster', 'info')];
            }

            // Filter entries with GPUs for the GPU leaderboard
            const gpuEntries = this.cachedEntries.filter(e => e.gpuCount > 0);

            const items: vscode.TreeItem[] = [];

            if (gpuEntries.length > 0) {
                items.push(new LeaderboardCategoryItem('gpu', gpuEntries));
            }

            items.push(new LeaderboardCategoryItem('jobs', this.cachedEntries));

            return items;
        } catch (error) {
            console.error('Error fetching leaderboard:', error);
            return [new LeaderboardMessageItem('Failed to fetch leaderboard', 'error')];
        }
    }
}
