import * as vscode from 'vscode';
import { SlurmJob, SlurmService, getStateDescription } from './slurmService';

/**
 * Tree item representing a SLURM job in the TreeView
 */
export class SlurmJobItem extends vscode.TreeItem {
    constructor(
        public readonly job: SlurmJob,
    ) {
        super(job.name, vscode.TreeItemCollapsibleState.None);

        this.description = `${job.jobId} • ${getStateDescription(job.state)}`;
        this.tooltip = this.createTooltip();
        this.iconPath = this.getStateIcon();
        this.contextValue = 'slurmJob';
    }

    private createTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**Job: ${this.job.name}**\n\n`);
        md.appendMarkdown(`| Property | Value |\n`);
        md.appendMarkdown(`|----------|-------|\n`);
        md.appendMarkdown(`| Job ID | ${this.job.jobId} |\n`);
        md.appendMarkdown(`| State | ${getStateDescription(this.job.state)} |\n`);
        md.appendMarkdown(`| Time | ${this.job.time} |\n`);
        md.appendMarkdown(`| Partition | ${this.job.partition} |\n`);
        md.appendMarkdown(`| Nodes | ${this.job.nodes} |\n`);
        return md;
    }

    private getStateIcon(): vscode.ThemeIcon {
        switch (this.job.state) {
            case 'R':  // Running
                return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.green'));
            case 'PD': // Pending
                return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.yellow'));
            case 'CG': // Completing
                return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue'));
            case 'CD': // Completed
                return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
            case 'F':  // Failed
            case 'TO': // Timeout
            case 'NF': // Node Fail
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            case 'CA': // Cancelled
                return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.orange'));
            case 'S':  // Suspended
                return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.purple'));
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }
}

/**
 * Message item shown when no jobs are found or SLURM is unavailable
 */
class MessageItem extends vscode.TreeItem {
    constructor(message: string, icon: string = 'info') {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

/**
 * TreeDataProvider for SLURM jobs
 * Provides data for the SLURM Jobs TreeView in the sidebar
 */
export class SlurmJobProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
        new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();

    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private slurmService: SlurmService;
    private isLoading: boolean = false;

    constructor() {
        this.slurmService = new SlurmService();
    }

    /**
     * Refresh the job list
     */
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        // Only show items at root level
        if (element) {
            return [];
        }

        this.isLoading = true;

        try {
            // Check if SLURM is available
            const isAvailable = await this.slurmService.isAvailable();
            if (!isAvailable) {
                return [new MessageItem('SLURM not available on this system', 'warning')];
            }

            // Fetch jobs
            const jobs = await this.slurmService.getJobs();

            if (jobs.length === 0) {
                return [new MessageItem('No jobs found', 'info')];
            }

            // Sort jobs: Running first, then Pending, then others
            const sortOrder: Record<string, number> = { 'R': 0, 'PD': 1, 'CG': 2 };
            jobs.sort((a, b) => {
                const orderA = sortOrder[a.state] ?? 99;
                const orderB = sortOrder[b.state] ?? 99;
                return orderA - orderB;
            });

            return jobs.map(job => new SlurmJobItem(job));
        } catch (error) {
            console.error('Error fetching SLURM jobs:', error);
            return [new MessageItem('Error fetching jobs', 'error')];
        } finally {
            this.isLoading = false;
        }
    }
}
