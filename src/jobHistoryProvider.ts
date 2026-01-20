import * as vscode from 'vscode';
import { HistoryJob, SlurmService, getHistoryStateInfo } from './slurmService';

/**
 * Tree item representing a job from history
 */
export class HistoryJobItem extends vscode.TreeItem {
    constructor(
        public readonly job: HistoryJob,
    ) {
        super(job.name, vscode.TreeItemCollapsibleState.Collapsed);

        const stateInfo = getHistoryStateInfo(job.state, job.exitCode);

        this.description = `${job.jobId} • ${stateInfo.description}`;
        this.tooltip = this.createTooltip();
        this.iconPath = new vscode.ThemeIcon(stateInfo.icon, new vscode.ThemeColor(stateInfo.color));
        this.contextValue = 'historyJob';
    }

    private createTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        const stateInfo = getHistoryStateInfo(this.job.state, this.job.exitCode);

        md.appendMarkdown(`**Job: ${this.job.name}**\n\n`);
        md.appendMarkdown(`| Property | Value |\n`);
        md.appendMarkdown(`|----------|-------|\n`);
        md.appendMarkdown(`| Job ID | ${this.job.jobId} |\n`);
        md.appendMarkdown(`| Status | ${stateInfo.description} |\n`);
        md.appendMarkdown(`| Exit Code | ${this.job.exitCode} |\n`);
        md.appendMarkdown(`| Elapsed | ${this.job.elapsed} |\n`);
        md.appendMarkdown(`| Start | ${this.job.startTime} |\n`);
        md.appendMarkdown(`| End | ${this.job.endTime} |\n`);
        md.appendMarkdown(`| Partition | ${this.job.partition} |\n`);
        md.appendMarkdown(`| Nodes | ${this.job.nodes} |\n`);

        if (this.job.cpus !== 'N/A') {
            md.appendMarkdown(`| CPUs | ${this.job.cpus} |\n`);
        }
        if (this.job.maxMemory !== 'N/A' && this.job.maxMemory) {
            md.appendMarkdown(`| Max Memory | ${this.job.maxMemory} |\n`);
        }

        return md;
    }
}

/**
 * Tree item for history job details
 */
export class HistoryDetailItem extends vscode.TreeItem {
    constructor(
        label: string,
        value: string,
        icon?: string,
        color?: string,
    ) {
        super(`${label}: ${value}`, vscode.TreeItemCollapsibleState.None);
        this.iconPath = icon ? new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined) : undefined;
        this.contextValue = 'historyDetail';
    }
}

/**
 * Tree item for history job file paths (stdout/stderr) - clickable
 */
export class HistoryFileItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly filePath: string,
        icon: string,
        public readonly job: HistoryJob,
    ) {
        super(`${label}: ${filePath}`, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = label === 'Stdout' ? 'historyStdout' : 'historyStderr';
        this.tooltip = `Click to open: ${filePath}`;

        // Make it clickable
        this.command = {
            command: 'slurmJobs.openFile',
            title: 'Open File',
            arguments: [filePath],
        };
    }
}

/**
 * Message item for the history view
 */
class HistoryMessageItem extends vscode.TreeItem {
    constructor(message: string, icon: string = 'info') {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

/**
 * TreeDataProvider for job history
 */
export class JobHistoryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
        new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();

    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private slurmService: SlurmService;
    private cachedJobs: HistoryJob[] = [];
    private historyDays: number = 7;

    constructor(slurmService: SlurmService) {
        this.slurmService = slurmService;
    }

    /**
     * Refresh the history
     */
    refresh(): void {
        this.cachedJobs = [];
        this._onDidChangeTreeData.fire();
    }

    /**
     * Set number of days to look back
     */
    setHistoryDays(days: number): void {
        this.historyDays = days;
        this.refresh();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        // Handle job children (details)
        if (element instanceof HistoryJobItem) {
            return this.getJobChildren(element.job);
        }

        // Root level: show jobs
        return this.getRootItems();
    }

    private async getRootItems(): Promise<vscode.TreeItem[]> {
        try {
            // Check if SLURM is available
            const isAvailable = await this.slurmService.isAvailable();
            if (!isAvailable) {
                return [new HistoryMessageItem('SLURM not available', 'warning')];
            }

            // Fetch history
            this.cachedJobs = await this.slurmService.getJobHistory(this.historyDays);

            if (this.cachedJobs.length === 0) {
                return [new HistoryMessageItem(`No jobs in the last ${this.historyDays} days`, 'info')];
            }

            return this.cachedJobs.map(job => new HistoryJobItem(job));
        } catch (error) {
            console.error('Error fetching job history:', error);
            return [new HistoryMessageItem('Error fetching history', 'error')];
        }
    }

    private getJobChildren(job: HistoryJob): vscode.TreeItem[] {
        const children: vscode.TreeItem[] = [];
        const stateInfo = getHistoryStateInfo(job.state, job.exitCode);

        // Status with color
        children.push(new HistoryDetailItem('Status', stateInfo.description, stateInfo.icon, stateInfo.color));
        children.push(new HistoryDetailItem('Exit Code', String(job.exitCode), job.exitCode === 0 ? 'check' : 'error', job.exitCode === 0 ? 'charts.green' : 'charts.red'));
        children.push(new HistoryDetailItem('Elapsed', job.elapsed, 'watch'));
        children.push(new HistoryDetailItem('Partition', job.partition, 'server'));
        children.push(new HistoryDetailItem('Nodes', job.nodes, 'vm'));

        if (job.cpus !== 'N/A') {
            children.push(new HistoryDetailItem('CPUs', job.cpus, 'pulse'));
        }
        if (job.maxMemory !== 'N/A' && job.maxMemory) {
            children.push(new HistoryDetailItem('Max Memory', job.maxMemory, 'dashboard'));
        }

        children.push(new HistoryDetailItem('Started', job.startTime, 'calendar'));
        children.push(new HistoryDetailItem('Ended', job.endTime, 'calendar'));

        // Add stdout/stderr paths if available (clickable)
        if (job.stdoutPath && job.stdoutPath !== 'N/A') {
            children.push(new HistoryFileItem('Stdout', job.stdoutPath, 'file', job));
        }
        if (job.stderrPath && job.stderrPath !== 'N/A') {
            children.push(new HistoryFileItem('Stderr', job.stderrPath, 'warning', job));
        }

        return children;
    }
}
