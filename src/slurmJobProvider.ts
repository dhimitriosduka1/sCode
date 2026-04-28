import * as vscode from 'vscode';
import { SlurmJob, SlurmService, getStateDescription, getPendingReasonInfo, calculateProgress, generateProgressBar, formatStartTime } from './slurmService';
import { getSlurmJobRowParts } from './slurmJobRow';
import { SubmitScriptCache } from './submitScriptCache';
import { PinnedJobsCache } from './pinnedJobsCache';
import { formatTooltipMarkdown, TooltipDetail } from './tooltipMarkdown';

/**
 * Status categories for grouping jobs
 */
type StatusCategory = 'pinned' | 'running' | 'pending' | 'completing' | 'other';

interface CategoryInfo {
    label: string;
    icon: vscode.ThemeIcon;
    states: string[];
}

const CATEGORIES: Record<StatusCategory, CategoryInfo> = {
    pinned: {
        label: 'Pinned',
        icon: new vscode.ThemeIcon('pinned', new vscode.ThemeColor('charts.blue')),
        states: [], // Pinned is not state-based
    },
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
        this.contextValue = category === 'pending' ? 'statusCategoryPending' : 'statusCategory';
    }
}

/**
 * Tree item representing a SLURM job in the TreeView
 */
export class SlurmJobItem extends vscode.TreeItem {
    constructor(
        public readonly job: SlurmJob,
        public readonly isPinned: boolean = false,
        isChecked: boolean = false,
    ) {
        const rowParts = getSlurmJobRowParts(job);
        super(rowParts.label, vscode.TreeItemCollapsibleState.Collapsed);

        this.description = rowParts.description;
        this.tooltip = this.createTooltip();
        this.iconPath = this.getStateIcon();
        // Use pending-specific context values so package.json can hide stdout/stderr/pin icons
        if (job.state === 'PD') {
            this.contextValue = isPinned ? 'slurmJobPendingPinned' : 'slurmJobPending';
        } else {
            this.contextValue = isPinned ? 'slurmJobPinned' : 'slurmJob';
        }
        this.checkboxState = isChecked
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
    }

    private createTooltip(): vscode.MarkdownString {
        const details: TooltipDetail[] = [
            { label: 'Job ID', value: this.job.jobId },
            { label: 'State', value: getStateDescription(this.job.state) },
        ];

        if (this.job.state !== 'PD') {
            details.push({ label: 'Elapsed', value: this.job.time });
        }
        details.push(
            { label: 'Time limit', value: this.job.timeLimit },
            { label: 'Partition', value: this.job.partition },
        );

        if (this.job.state !== 'PD') {
            details.push({ label: 'Nodes', value: this.job.nodes });
        }

        if (this.job.state === 'PD') {
            const reasonInfo = getPendingReasonInfo(this.job.pendingReason);
            if (reasonInfo) {
                details.push(
                    { label: 'Pending reason', value: reasonInfo.description },
                    { label: 'Reason code', value: reasonInfo.code },
                );
            }
            details.push({ label: 'Est. start', value: formatStartTime(this.job.startTime) });
        }

        if (this.job.state === 'R') {
            const progress = calculateProgress(this.job.time, this.job.timeLimit);
            if (progress >= 0) {
                details.push({ label: 'Progress', value: generateProgressBar(progress, 8) });
            }
        }

        const sections = [];
        if (this.job.state !== 'PD') {
            sections.push({
                title: 'Output files',
                lines: [
                    `stdout: \`${this.job.stdoutPath}\``,
                    `stderr: \`${this.job.stderrPath}\``,
                ],
            });
        }

        return new vscode.MarkdownString(formatTooltipMarkdown({
            title: `Job: ${this.job.name}`,
            summary: `${getStateDescription(this.job.state)} · ${this.job.jobId}`,
            details,
            sections,
        }));
    }

    private getStateIcon(): vscode.ThemeIcon {
        // Pinned jobs get a special icon
        if (this.isPinned) {
            return new vscode.ThemeIcon('pinned', new vscode.ThemeColor('charts.blue'));
        }

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

        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title: label,
            summary: 'Click to open this file.',
            details: [{ label: 'Path', value: `\`${filePath}\`` }],
        }));
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
            this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
                title: 'Submit script',
                summary: 'Cached at submission time',
                details: [
                    { label: 'Cached at', value: cachedAt || 'Unknown' },
                    { label: 'Path', value: `\`${filePath}\`` },
                ],
                note: 'Click to open the script as it was at submission time.',
            }));
            this.iconPath = new vscode.ThemeIcon('archive', new vscode.ThemeColor('charts.blue'));
        } else {
            this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
                title: 'Submit script',
                summary: 'Current file',
                details: [{ label: 'Path', value: `\`${filePath}\`` }],
                note: 'Click to open the current version of the script.',
            }));
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
        const funTitles = ['🐷 Job Hog', '🔥 Cluster Dominator', '🤗 CUDA Cuddler', '😋 Node Nom-Nom'];
        const title = funTitles[Math.floor(Math.random() * funTitles.length)];
        super(`${title}: ${username} (${jobCount} jobs)`, vscode.TreeItemCollapsibleState.None);
        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title,
            summary: `${username} has the most running jobs.`,
            details: [
                { label: 'User', value: username },
                { label: 'Running jobs', value: jobCount },
            ],
        }));
        this.contextValue = 'jobHog';
    }
}

/**
 * Fun item showing the user with the most GPUs allocated
 */
class GpuHogItem extends vscode.TreeItem {
    constructor(username: string, gpuCount: number) {
        const funTitles = ['🧛 VRAMpire', '🎮 GPU Gobbler', '⚡ Watt Wizard', '🏋️ Tensor Titan'];
        const title = funTitles[Math.floor(Math.random() * funTitles.length)];
        super(`${title}: ${username} (${gpuCount} GPUs)`, vscode.TreeItemCollapsibleState.None);
        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title,
            summary: `${username} has the most allocated GPUs.`,
            details: [
                { label: 'User', value: username },
                { label: 'Allocated GPUs', value: gpuCount },
            ],
        }));
        this.contextValue = 'gpuHog';
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
    private pinnedCache?: PinnedJobsCache;
    private checkedJobIds?: Set<string>;
    private isLoading: boolean = false;
    private cachedJobs: SlurmJob[] = [];
    private searchFilter: string = '';

    constructor(slurmService: SlurmService, scriptCache?: SubmitScriptCache, pinnedCache?: PinnedJobsCache, checkedJobIds?: Set<string>) {
        this.slurmService = slurmService;
        this.scriptCache = scriptCache;
        this.pinnedCache = pinnedCache;
        this.checkedJobIds = checkedJobIds;
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

        return this.cachedJobs.filter(job => {
            const reasonInfo = getPendingReasonInfo(job.pendingReason);
            return job.name.toLowerCase().includes(this.searchFilter) ||
                job.jobId.toLowerCase().includes(this.searchFilter) ||
                reasonInfo?.code.toLowerCase().includes(this.searchFilter) ||
                reasonInfo?.label.toLowerCase().includes(this.searchFilter);
        });
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

                // Clean up stale pinned jobs
                if (this.pinnedCache) {
                    const activeJobIds = new Set(this.cachedJobs.map(j => j.jobId));
                    await this.pinnedCache.cleanupStaleJobs(activeJobIds);
                }

                // Clean up stale checked jobs (jobs that no longer exist)
                if (this.checkedJobIds && this.checkedJobIds.size > 0) {
                    const activeJobIds = new Set(this.cachedJobs.map(j => j.jobId));
                    for (const checkedId of this.checkedJobIds) {
                        if (!activeJobIds.has(checkedId)) {
                            this.checkedJobIds.delete(checkedId);
                        }
                    }
                }
            }

            const filteredJobs = this.getFilteredJobs();

            // Always fetch and show cluster hogs (cluster-wide stats)
            const { topJobHog, topGpuHog } = await this.slurmService.getClusterHogs();
            const jobHogItem = topJobHog && topJobHog.jobCount > 1
                ? new JobHogItem(topJobHog.username, topJobHog.jobCount)
                : null;
            const gpuHogItem = topGpuHog && topGpuHog.gpuCount > 0
                ? new GpuHogItem(topGpuHog.username, topGpuHog.gpuCount)
                : null;

            if (this.cachedJobs.length === 0) {
                const items: vscode.TreeItem[] = [];
                if (jobHogItem) { items.push(jobHogItem); }
                if (gpuHogItem) { items.push(gpuHogItem); }
                items.push(new MessageItem('No jobs found', 'info'));
                return items;
            }

            if (filteredJobs.length === 0 && this.searchFilter) {
                const items: vscode.TreeItem[] = [];
                if (jobHogItem) { items.push(jobHogItem); }
                if (gpuHogItem) { items.push(gpuHogItem); }
                items.push(new MessageItem(`No jobs matching "${this.searchFilter}"`, 'search'));
                return items;
            }

            // Create category items
            const categories: vscode.TreeItem[] = [];

            // Add cluster hogs at the top
            if (jobHogItem) { categories.push(jobHogItem); }
            if (gpuHogItem) { categories.push(gpuHogItem); }

            // Add Pinned category first if there are pinned jobs
            if (this.pinnedCache) {
                const pinnedCount = filteredJobs.filter(job =>
                    this.pinnedCache!.isPinned(job.jobId)
                ).length;

                if (pinnedCount > 0) {
                    categories.push(new StatusCategoryItem('pinned', pinnedCount));
                }
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
        const filteredJobs = this.getFilteredJobs();

        // Handle pinned category specially
        if (category === 'pinned') {
            const pinnedJobs = filteredJobs.filter(job =>
                this.pinnedCache?.isPinned(job.jobId)
            );
            // Sort by job ID (descending - newest first)
            pinnedJobs.sort((a, b) => parseInt(b.jobId) - parseInt(a.jobId));
            return pinnedJobs.map(job => new SlurmJobItem(job, true, this.checkedJobIds?.has(job.jobId) ?? false));
        }

        const info = CATEGORIES[category];
        const jobs = filteredJobs.filter(job => info.states.includes(job.state));

        // Sort jobs by job ID (descending - newest first)
        jobs.sort((a, b) => parseInt(b.jobId) - parseInt(a.jobId));

        // Check if each job is pinned and/or checked
        return jobs.map(job => new SlurmJobItem(
            job,
            this.pinnedCache?.isPinned(job.jobId) ?? false,
            this.checkedJobIds?.has(job.jobId) ?? false
        ));
    }

    private getJobChildren(job: SlurmJob): vscode.TreeItem[] {
        const children: vscode.TreeItem[] = [];
        const isPending = job.state === 'PD';

        // Add job details
        children.push(new JobDetailItem('Partition', job.partition, 'server'));

        if (!isPending) {
            children.push(new JobDetailItem('Nodes', job.nodes, 'vm'));
            children.push(new JobDetailItem('Elapsed', job.time, 'watch'));
        }

        children.push(new JobDetailItem('Time Limit', job.timeLimit, 'clock'));

        if (job.state === 'R') {
            const progress = calculateProgress(job.time, job.timeLimit);
            if (progress >= 0) {
                children.push(new JobDetailItem('Progress', `${progress}%`, 'pie-chart'));
            }
        }

        // Show GPU info for any job that requested GPUs
        if (job.gpuCount && job.gpuCount > 0) {
            if (job.gpuType) {
                children.push(new JobDetailItem('GPU', `${job.gpuCount}x ${job.gpuType}`, 'circuit-board'));
            } else {
                children.push(new JobDetailItem('GPUs', `${job.gpuCount}`, 'circuit-board'));
            }
        }

        // Show allocated memory
        if (job.memory) {
            children.push(new JobDetailItem('Memory', job.memory, 'database'));
        }

        if (job.state === 'PD') {
            const reasonInfo = getPendingReasonInfo(job.pendingReason);
            if (reasonInfo) {
                children.push(new JobDetailItem('Pending Reason', reasonInfo.description, 'question'));
                children.push(new JobDetailItem('Reason Code', reasonInfo.code, 'symbol-key'));
            }

            const startTime = formatStartTime(job.startTime);
            children.push(new JobDetailItem('Est. Start', startTime, 'calendar'));
        }

        // Show dependency info for any job that has dependencies
        if (job.dependency) {
            children.push(new JobDetailItem('Depends on', job.dependency, 'link'));
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

        // Add output file links (not for pending jobs)
        if (!isPending && job.stdoutPath && job.stdoutPath !== 'N/A') {
            children.push(new OutputFileItem('stdout', job.stdoutPath, 'stdout'));
        }
        if (!isPending && job.stderrPath && job.stderrPath !== 'N/A') {
            children.push(new OutputFileItem('stderr', job.stderrPath, 'stderr'));
        }

        return children;
    }
}
