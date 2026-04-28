import * as vscode from 'vscode';
import { HistoryJob, SlurmService, getHistoryStateInfo, expandPathPlaceholders } from './slurmService';
import { formatTooltipMarkdown, TooltipDetail } from './tooltipMarkdown';
import { formatLeaderboardRefreshLabel } from './leaderboardRefreshTime';
import {
    formatHistoryJobDescription,
    formatHistorySummaryDescription,
    formatHistorySummaryTooltip,
    groupHistoryJobsByEndDate,
    HistoryDateGroup,
    normalizeHistoryDays,
} from './historyViewModel';

/**
 * Tree item representing a job from Job History.
 */
export class HistoryJobItem extends vscode.TreeItem {
    constructor(
        public readonly job: HistoryJob,
    ) {
        super(job.name, vscode.TreeItemCollapsibleState.Collapsed);

        const stateInfo = getHistoryStateInfo(job.state, job.exitCode);

        this.description = formatHistoryJobDescription(job);
        this.tooltip = this.createTooltip();
        this.iconPath = new vscode.ThemeIcon(stateInfo.icon, new vscode.ThemeColor(stateInfo.color));
        this.contextValue = 'historyJob';
    }

    private createTooltip(): vscode.MarkdownString {
        const stateInfo = getHistoryStateInfo(this.job.state, this.job.exitCode);
        const details: TooltipDetail[] = [
            { label: 'Job ID', value: this.job.jobId },
            { label: 'Status', value: stateInfo.description },
            { label: 'Exit code', value: this.job.exitCode },
            { label: 'Elapsed', value: this.job.elapsed },
            { label: 'Start', value: this.job.startTime },
            { label: 'End', value: this.job.endTime },
            { label: 'Partition', value: this.job.partition },
            { label: 'Nodes', value: this.job.nodes },
        ];

        if (this.job.cpus !== 'N/A') {
            details.push({ label: 'CPUs', value: this.job.cpus });
        }
        if (this.job.maxMemory !== 'N/A' && this.job.maxMemory) {
            details.push({ label: 'Max memory', value: this.job.maxMemory });
        }

        return new vscode.MarkdownString(formatTooltipMarkdown({
            title: `Job: ${this.job.name}`,
            summary: `${stateInfo.description} · ${this.job.jobId}`,
            details,
        }));
    }
}

/**
 * Tree item for Job History job details.
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
 * Tree item for Job History job file paths (stdout/stderr) - clickable.
 */
export class HistoryFileItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly filePath: string,
        icon: string,
        public readonly job: HistoryJob,
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = label === 'Stdout' ? 'historyStdout' : 'historyStderr';
        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title: label,
            summary: 'Click to open this file.',
            details: [{ label: 'Path', value: `\`${filePath}\`` }],
        }));

        // Make it clickable
        this.command = {
            command: 'slurmJobs.openFile',
            title: 'Open File',
            arguments: [filePath],
        };
    }
}

/**
 * Summary item showing fetch time, Job History range, and job count.
 */
class HistorySummaryItem extends vscode.TreeItem {
    constructor(
        refreshedAt: Date,
        historyDays: number,
        totalJobs: number,
        filteredJobs: number,
        searchFilter: string,
    ) {
        super(formatLeaderboardRefreshLabel(refreshedAt), vscode.TreeItemCollapsibleState.None);
        this.description = formatHistorySummaryDescription(historyDays, totalJobs, filteredJobs, searchFilter);
        this.iconPath = new vscode.ThemeIcon('history');
        this.contextValue = 'historySummary';
        this.tooltip = new vscode.MarkdownString(
            formatHistorySummaryTooltip(refreshedAt, historyDays, totalJobs, filteredJobs, searchFilter)
        );
    }
}

/**
 * Date group item for history jobs.
 */
class HistoryDateGroupItem extends vscode.TreeItem {
    constructor(public readonly group: HistoryDateGroup) {
        super(group.label, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('calendar');
        this.contextValue = 'historyDateGroup';
    }
}

/**
 * Message item for the Job History view.
 */
class HistoryMessageItem extends vscode.TreeItem {
    constructor(message: string, icon: string = 'info') {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
    }
}

/**
 * Pagination control item for the history view
 */
class PaginationControlItem extends vscode.TreeItem {
    constructor(message: string, icon?: string) {
        super(message, vscode.TreeItemCollapsibleState.None);
        if (icon) {
            this.iconPath = new vscode.ThemeIcon(icon);
        }
        this.contextValue = 'paginationControl';
    }
}

/**
 * TreeDataProvider for Job History.
 */
export class JobHistoryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> =
        new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();

    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private slurmService: SlurmService;
    private cachedJobs: HistoryJob[] = [];
    private cachedSlurmAvailable: boolean | null = null;
    private lastRefreshedAt: Date | undefined;
    private hasFetchedJobs = false;
    private historyDays: number = 7;
    private searchFilter: string = '';
    private currentPage: number = 0;
    private itemsPerPage: number = 20;
    private totalFilteredJobs: number = 0;

    constructor(slurmService: SlurmService) {
        this.slurmService = slurmService;
    }

    /**
     * Refresh the history (forces re-fetch from sacct)
     */
    refresh(): void {
        this.cachedJobs = [];
        this.cachedSlurmAvailable = null;
        this.lastRefreshedAt = undefined;
        this.hasFetchedJobs = false;
        this._onDidChangeTreeData.fire();
    }

    /**
     * Fire tree change event to update UI without re-fetching
     */
    private updateView(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * Set number of days to look back
     */
    setHistoryDays(days: number): void {
        this.historyDays = normalizeHistoryDays(days);
        this.currentPage = 0;
        this.refresh();
    }

    /**
     * Get number of days to look back.
     */
    getHistoryDays(): number {
        return this.historyDays;
    }

    /**
     * Set search filter for job names
     */
    setSearchFilter(filter: string): void {
        this.searchFilter = filter;
        this.currentPage = 0; // Reset to first page when filtering
        this._onDidChangeTreeData.fire();
    }

    /**
     * Clear search filter
     */
    clearSearchFilter(): void {
        this.searchFilter = '';
        this.currentPage = 0;
        this._onDidChangeTreeData.fire();
    }

    /**
     * Get current search filter
     */
    getSearchFilter(): string {
        return this.searchFilter;
    }

    /**
     * Navigate to next page
     */
    nextPage(): void {
        const maxPage = Math.max(0, Math.ceil(this.totalFilteredJobs / this.itemsPerPage) - 1);
        if (this.currentPage < maxPage) {
            this.currentPage++;
            this._onDidChangeTreeData.fire();
        }
    }

    /**
     * Navigate to previous page
     */
    previousPage(): void {
        if (this.currentPage > 0) {
            this.currentPage--;
            this._onDidChangeTreeData.fire();
        }
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        // Handle job children (details) - fetch paths lazily here
        if (element instanceof HistoryJobItem) {
            return await this.getJobChildren(element.job);
        }

        if (element instanceof HistoryDateGroupItem) {
            return element.group.jobs.map(job => new HistoryJobItem(job));
        }

        // Root level: show jobs
        return this.getRootItems();
    }

    private async getRootItems(): Promise<vscode.TreeItem[]> {
        try {
            // Skip availability check if we already have cached jobs
            if (!this.hasFetchedJobs) {
                // Check if SLURM is available (cache the result)
                if (this.cachedSlurmAvailable === null) {
                    this.cachedSlurmAvailable = await this.slurmService.isAvailable();
                }
                if (!this.cachedSlurmAvailable) {
                    return [new HistoryMessageItem('SLURM not available', 'warning')];
                }

                // Fetch history
                this.cachedJobs = await this.slurmService.getJobHistory(this.historyDays);
                this.lastRefreshedAt = new Date();
                this.hasFetchedJobs = true;
            }

            // Apply search filter
            let filteredJobs = this.cachedJobs;
            if (this.searchFilter) {
                const filterLower = this.searchFilter.toLowerCase();
                filteredJobs = this.cachedJobs.filter(job =>
                    job.name.toLowerCase().includes(filterLower) ||
                    job.jobId.includes(this.searchFilter)
                );

            }

            this.totalFilteredJobs = filteredJobs.length;
            const items: vscode.TreeItem[] = [];

            if (this.lastRefreshedAt) {
                items.push(new HistorySummaryItem(
                    this.lastRefreshedAt,
                    this.historyDays,
                    this.cachedJobs.length,
                    filteredJobs.length,
                    this.searchFilter,
                ));
            }

            if (this.cachedJobs.length === 0) {
                items.push(new HistoryMessageItem(`No jobs in the last ${this.historyDays} days`, 'info'));
                return items;
            }

            if (filteredJobs.length === 0) {
                items.push(new HistoryMessageItem(`No jobs match "${this.searchFilter}"`, 'search'));
                return items;
            }

            // Calculate pagination
            const totalPages = Math.ceil(this.totalFilteredJobs / this.itemsPerPage);
            this.currentPage = Math.min(this.currentPage, Math.max(0, totalPages - 1));
            const startIndex = this.currentPage * this.itemsPerPage;
            const endIndex = Math.min(startIndex + this.itemsPerPage, this.totalFilteredJobs);
            const pageJobs = filteredJobs.slice(startIndex, endIndex);

            // Add pagination info at the top if there are multiple pages
            if (totalPages > 1) {
                const pageInfo = new PaginationControlItem(
                    `Page ${this.currentPage + 1} of ${totalPages} (${this.totalFilteredJobs} jobs${this.searchFilter ? ' filtered' : ''})`,
                    'list-ordered'
                );
                items.push(pageInfo);
            }

            // Add grouped job items
            items.push(...groupHistoryJobsByEndDate(pageJobs).map(group => new HistoryDateGroupItem(group)));

            return items;
        } catch (error) {
            console.error('Error fetching Job History:', error);
            return [new HistoryMessageItem('Error fetching Job History', 'error')];
        }
    }

    /**
     * Get children for a job item - fetches paths lazily
     */
    private async getJobChildren(job: HistoryJob): Promise<vscode.TreeItem[]> {
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

        // Lazy-load stdout/stderr paths only when the job is expanded
        if (job.stdoutPath === 'N/A' && job.stderrPath === 'N/A') {
            // Paths not yet fetched - fetch them now
            const paths = await this.slurmService.getHistoryJobPaths(job.jobId, {
                jobName: job.name,
                nodes: job.nodes,
            });
            job.stdoutPath = expandPathPlaceholders(paths.stdoutPath, job.jobId, job.name, job.nodes);
            job.stderrPath = expandPathPlaceholders(paths.stderrPath, job.jobId, job.name, job.nodes);
        }

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
