import * as vscode from 'vscode';
import { SlurmJob, SlurmService, getStateDescription, calculateProgress, generateProgressBar, formatStartTime } from './slurmService';
import { SubmitScriptCache } from './submitScriptCache';

/**
 * Status categories for grouping jobs
 */
type StatusCategory = 'running' | 'pending' | 'completing' | 'other';

interface CategoryInfo {
    label: string;
    icon: vscode.ThemeIcon;
    states: string[];
}

const CATEGORIES: Record<StatusCategory, CategoryInfo> = {
    running: {
        label: 'Running',
        icon: new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.green')),
        states: ['R'],
    },
    pending: {
        label: 'Pending',
        icon: new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.yellow')),
        states: ['PD'],
    },
    completing: {
        label: 'Completing',
        icon: new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue')),
        states: ['CG'],
    },
    other: {
        label: 'Other',
        icon: new vscode.ThemeIcon('circle-outline'),
        states: ['CD', 'F', 'TO', 'CA', 'NF', 'PR', 'S'],
    },
};

/**
 * Category item representing a group of jobs by status
 */
export class StatusCategoryItem extends vscode.TreeItem {
    constructor(
        public readonly category: StatusCategory,
        public readonly jobCount: number,
    ) {
        const info = CATEGORIES[category];
        super(
            `${info.label} (${jobCount})`,
            jobCount > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );

        this.iconPath = info.icon;
        this.contextValue = 'statusCategory';
    }
}

/**
 * Tree item representing a SLURM job in the TreeView
 */
export class SlurmJobItem extends vscode.TreeItem {
    constructor(
        public readonly job: SlurmJob,
    ) {
        super(job.name, vscode.TreeItemCollapsibleState.Collapsed);

        this.description = this.createDescription();
        this.tooltip = this.createTooltip();
        this.iconPath = this.getStateIcon();
        this.contextValue = 'slurmJob';
    }

    private createDescription(): string {
        const parts: string[] = [this.job.jobId];

        if (this.job.state === 'R') {
            // Running: show progress
            const progress = calculateProgress(this.job.time, this.job.timeLimit);
            if (progress >= 0) {
                parts.push(generateProgressBar(progress, 8));
            } else {
                parts.push(this.job.time);
            }
        } else if (this.job.state === 'PD') {
            // Pending: show estimated start time
            const startStr = formatStartTime(this.job.startTime);
            parts.push(`Starts: ~${startStr}`);
        } else {
            parts.push(getStateDescription(this.job.state));
        }

        return parts.join(' • ');
    }

    private createTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**Job: ${this.job.name}**\n\n`);
        md.appendMarkdown(`| Property | Value |\n`);
        md.appendMarkdown(`|----------|-------|\n`);
        md.appendMarkdown(`| Job ID | ${this.job.jobId} |\n`);
        md.appendMarkdown(`| State | ${getStateDescription(this.job.state)} |\n`);
        md.appendMarkdown(`| Elapsed | ${this.job.time} |\n`);
        md.appendMarkdown(`| Time Limit | ${this.job.timeLimit} |\n`);
        md.appendMarkdown(`| Partition | ${this.job.partition} |\n`);
        md.appendMarkdown(`| Nodes | ${this.job.nodes} |\n`);

        if (this.job.state === 'PD') {
            md.appendMarkdown(`| Est. Start | ${formatStartTime(this.job.startTime)} |\n`);
        }

        if (this.job.state === 'R') {
            const progress = calculateProgress(this.job.time, this.job.timeLimit);
            if (progress >= 0) {
                md.appendMarkdown(`| Progress | ${progress}% |\n`);
            }
        }

        md.appendMarkdown(`\n---\n`);
        md.appendMarkdown(`**Output Files:**\n`);
        md.appendMarkdown(`- stdout: \`${this.job.stdoutPath}\`\n`);
        md.appendMarkdown(`- stderr: \`${this.job.stderrPath}\`\n`);

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
 * Tree item for output file links
 */
export class OutputFileItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly filePath: string,
        public readonly fileType: 'stdout' | 'stderr',
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        this.tooltip = `Click to open: ${filePath}`;
        this.iconPath = new vscode.ThemeIcon(fileType === 'stdout' ? 'output' : 'warning');
        this.contextValue = 'outputFile';

        // Make the item clickable to open the file
        this.command = {
            command: 'slurmJobs.openFile',
            title: 'Open File',
            arguments: [filePath],
        };

        this.description = filePath;
    }
}

/**
 * Tree item for job detail info
 */
export class JobDetailItem extends vscode.TreeItem {
    constructor(
        label: string,
        value: string,
        icon?: string,
    ) {
        super(`${label}: ${value}`, vscode.TreeItemCollapsibleState.None);
        this.iconPath = icon ? new vscode.ThemeIcon(icon) : undefined;
        this.contextValue = 'jobDetail';
    }
}

/**
 * Tree item for submit script links (current vs cached)
 */
class SubmitScriptItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly filePath: string,
        public readonly isCached: boolean,
        public readonly cachedAt?: string,
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        if (isCached) {
            this.tooltip = `Cached at: ${cachedAt}\nClick to open the script as it was at submission time`;
            this.iconPath = new vscode.ThemeIcon('archive', new vscode.ThemeColor('charts.blue'));
        } else {
            this.tooltip = `Current file: ${filePath}\nClick to open the current version of the script`;
            this.iconPath = new vscode.ThemeIcon('file-code');
        }

        this.contextValue = 'submitScript';
        this.description = isCached ? '(cached at submission)' : filePath;

        // Make the item clickable to open the file
        this.command = {
            command: 'slurmJobs.openFile',
            title: 'Open File',
            arguments: [filePath],
        };
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
 * Fun item showing the user with the most running jobs
 */
class JobHogItem extends vscode.TreeItem {
    constructor(username: string, jobCount: number) {
        const funTitles = ['🐷 Job Hog', '👑 Resource King', '🔥 Cluster Dominator'];
        const title = funTitles[Math.floor(Math.random() * funTitles.length)];
        super(`${title}: ${username} (${jobCount} jobs)`, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${username} is currently hogging the cluster with ${jobCount} running jobs!`;
        this.contextValue = 'jobHog';
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
    private scriptCache?: SubmitScriptCache;
    private isLoading: boolean = false;
    private cachedJobs: SlurmJob[] = [];
    private searchFilter: string = '';

    constructor(slurmService: SlurmService, scriptCache?: SubmitScriptCache) {
        this.slurmService = slurmService;
        this.scriptCache = scriptCache;
    }

    /**
     * Refresh the job list
     */
    refresh(): void {
        this.cachedJobs = [];
        this._onDidChangeTreeData.fire();
    }

    /**
     * Set search filter and refresh
     */
    setSearchFilter(filter: string): void {
        this.searchFilter = filter.toLowerCase();
        this._onDidChangeTreeData.fire();
    }

    /**
     * Clear search filter
     */
    clearSearchFilter(): void {
        this.searchFilter = '';
        this._onDidChangeTreeData.fire();
    }

    /**
     * Get current search filter
     */
    getSearchFilter(): string {
        return this.searchFilter;
    }

    /**
     * Get filtered jobs based on search
     */
    private getFilteredJobs(): SlurmJob[] {
        if (!this.searchFilter) {
            return this.cachedJobs;
        }

        return this.cachedJobs.filter(job =>
            job.name.toLowerCase().includes(this.searchFilter) ||
            job.jobId.toLowerCase().includes(this.searchFilter)
        );
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        // Handle job children (output files and details)
        if (element instanceof SlurmJobItem) {
            return this.getJobChildren(element.job);
        }

        // Handle category children (jobs in that category)
        if (element instanceof StatusCategoryItem) {
            return this.getCategoryChildren(element.category);
        }

        // Root level: show categories
        return this.getRootItems();
    }

    private async getRootItems(): Promise<vscode.TreeItem[]> {
        this.isLoading = true;

        try {
            // Check if SLURM is available
            const isAvailable = await this.slurmService.isAvailable();
            if (!isAvailable) {
                return [new MessageItem('SLURM not available on this system', 'warning')];
            }

            // Fetch and cache jobs only if cache is empty
            if (this.cachedJobs.length === 0) {
                this.cachedJobs = await this.slurmService.getJobs();
            }

            const filteredJobs = this.getFilteredJobs();

            if (this.cachedJobs.length === 0) {
                return [new MessageItem('No jobs found', 'info')];
            }

            if (filteredJobs.length === 0 && this.searchFilter) {
                return [new MessageItem(`No jobs matching "${this.searchFilter}"`, 'search')];
            }

            // Create category items
            const categories: vscode.TreeItem[] = [];

            // Add the "job hog" at the top for fun
            const topHog = await this.slurmService.getTopJobHog();
            if (topHog && topHog.jobCount > 1) {
                categories.push(new JobHogItem(topHog.username, topHog.jobCount));
            }

            for (const categoryKey of ['running', 'pending', 'completing', 'other'] as StatusCategory[]) {
                const info = CATEGORIES[categoryKey];
                const jobCount = filteredJobs.filter(job =>
                    info.states.includes(job.state)
                ).length;

                if (jobCount > 0) {
                    categories.push(new StatusCategoryItem(categoryKey, jobCount));
                }
            }

            return categories;
        } catch (error) {
            console.error('Error fetching SLURM jobs:', error);
            return [new MessageItem('Error fetching jobs', 'error')];
        } finally {
            this.isLoading = false;
        }
    }

    private getCategoryChildren(category: StatusCategory): vscode.TreeItem[] {
        const info = CATEGORIES[category];
        const filteredJobs = this.getFilteredJobs();
        const jobs = filteredJobs.filter(job => info.states.includes(job.state));

        // Sort jobs by job ID (descending - newest first)
        jobs.sort((a, b) => parseInt(b.jobId) - parseInt(a.jobId));

        return jobs.map(job => new SlurmJobItem(job));
    }

    private getJobChildren(job: SlurmJob): vscode.TreeItem[] {
        const children: vscode.TreeItem[] = [];

        // Add job details
        children.push(new JobDetailItem('Partition', job.partition, 'server'));
        children.push(new JobDetailItem('Nodes', job.nodes, 'vm'));
        children.push(new JobDetailItem('Elapsed', job.time, 'watch'));
        children.push(new JobDetailItem('Time Limit', job.timeLimit, 'clock'));

        if (job.state === 'R') {
            const progress = calculateProgress(job.time, job.timeLimit);
            if (progress >= 0) {
                children.push(new JobDetailItem('Progress', `${progress}%`, 'pie-chart'));
            }
        }

        if (job.state === 'PD') {
            const startTime = formatStartTime(job.startTime);
            children.push(new JobDetailItem('Est. Start', startTime, 'calendar'));
        }

        // Add submit script links
        if (job.submitScript && job.submitScript !== 'N/A') {
            // Current version of the script
            children.push(new SubmitScriptItem(
                'Submit Script (current)',
                job.submitScript,
                false
            ));

            // Cached version (if available)
            if (this.scriptCache && this.scriptCache.has(job.jobId)) {
                const cachedPath = this.scriptCache.getCachedScriptPath(job.jobId);
                const cachedAt = this.scriptCache.formatCacheTime(job.jobId);
                if (cachedPath) {
                    children.push(new SubmitScriptItem(
                        'Submit Script (cached)',
                        cachedPath,
                        true,
                        cachedAt
                    ));
                }
            }
        }

        // Add output file links
        if (job.stdoutPath && job.stdoutPath !== 'N/A') {
            children.push(new OutputFileItem('stdout', job.stdoutPath, 'stdout'));
        }
        if (job.stderrPath && job.stderrPath !== 'N/A') {
            children.push(new OutputFileItem('stderr', job.stderrPath, 'stderr'));
        }

        return children;
    }
}
