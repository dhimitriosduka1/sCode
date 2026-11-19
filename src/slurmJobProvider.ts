import * as vscode from 'vscode';
import { SlurmJob, SlurmService, MaintenanceWindow, JobPriorityFactors, getStateDescription, getPendingReasonInfo, calculateProgress, calculateRemainingSeconds, formatRemainingTime, formatDuration, generateProgressBar, formatStartTime, isJobHeld, isNearTimeLimit } from './slurmService';
import {
    buildFairShareLookup,
    FairShareSummary,
    formatFairShareHeaderLabel,
    formatFairShareTooltip,
    findJobPriorityFactors,
    formatJobPriorityDetails,
    getDominantPriorityComponent,
    getFairShareSummary,
    rankJobAccounts,
} from './fairShareRanking';
import { ActiveJobCategory, getActiveJobCategory, getCategoryGroupState, getSlurmJobRowParts } from './slurmJobRow';
import { DependencyStatus, QueueDependencies } from './jobDependencies';
import { createMaintenanceWarningItem } from './maintenanceWarningItem';
import { RefreshGate } from './refreshGate';
import { showRefreshTime } from './leaderboardRefreshTime';
import { SubmitScriptCache } from './submitScriptCache';
import { formatGpuTypeBreakdown, summarizeRunningGpus, UserGpuUsage } from './userGpuUsage';
import { countJobs } from './jobCount';

import { formatTooltipMarkdown, TooltipDetail } from './tooltipMarkdown';


const CATEGORIES: Record<ActiveJobCategory, { label: string; icon: vscode.ThemeIcon }> = {
    running: {
        label: 'Running',
        icon: new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.green')),
    },
    pending: {
        label: 'Pending',
        icon: new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.yellow')),
    },
    held: {
        label: 'Held',
        icon: new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.orange')),
    },
    neverRuns: {
        label: 'Will Never Run',
        icon: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red')),
    },
    completing: {
        label: 'Completing',
        icon: new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue')),
    },
    other: {
        label: 'Other',
        icon: new vscode.ThemeIcon('circle-outline'),
    },
};

/** Groups listed even when they hold no jobs, so the view keeps its shape between refreshes. */
const ALWAYS_SHOWN_CATEGORIES: ReadonlySet<ActiveJobCategory> = new Set(['running', 'held', 'pending']);

/**
 * Category item representing a group of jobs by status
 */
export class StatusCategoryItem extends vscode.TreeItem {
    public readonly jobCount: number;

    constructor(
        public readonly category: ActiveJobCategory,
        public readonly jobs: SlurmJob[],
        /** The whole queue's dependencies as loaded with `jobs`, since a job's row names the jobs it waits for. */
        public readonly dependencies?: QueueDependencies,
    ) {
        const info = CATEGORIES[category];
        const jobCount = countJobs(jobs.map(job => job.jobId));
        const group = getCategoryGroupState(category, jobs.length);
        super(
            `${info.label} (${jobCount})`,
            group.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
        );

        this.id = group.id;
        this.jobCount = jobCount;
        this.iconPath = info.icon;
        if (jobs.length === 0) {
            // No group actions apply to an empty group
            this.contextValue = 'statusCategoryEmpty';
        } else if (category === 'pending') {
            const hasNonHeld = jobs.some(job => !isJobHeld(job.pendingReason));
            const hasHeld = jobs.some(job => isJobHeld(job.pendingReason));
            this.contextValue = `statusCategoryPending${hasNonHeld ? 'HasNonHeld' : ''}${hasHeld ? 'HasHeld' : ''}`;
        } else if (category === 'held') {
            this.contextValue = 'statusCategoryHeld';
        } else if (category === 'neverRuns') {
            this.contextValue = 'statusCategoryNeverRuns';
        } else if (category === 'running') {
            this.contextValue = 'statusCategoryRunning';
        } else {
            this.contextValue = 'statusCategory';
        }
    }
}

/**
 * Tree item representing a SLURM job in the TreeView
 */
export class SlurmJobItem extends vscode.TreeItem {
    constructor(
        public readonly job: SlurmJob,
        isChecked: boolean = false,
        private readonly priorityFactors?: JobPriorityFactors,
        dependency?: DependencyStatus,
    ) {
        const rowParts = getSlurmJobRowParts(job, dependency);
        super(rowParts.label, vscode.TreeItemCollapsibleState.Collapsed);

        this.description = rowParts.description;
        this.tooltip = this.createTooltip();
        this.iconPath = this.getStateIcon(dependency);
        // Use pending-specific context values so package.json can show the right inline actions
        const isMainJobArray = job.jobId.includes('[');
        const isHeld = isJobHeld(job.pendingReason);
        if (job.state === 'PD') {
            if (isMainJobArray) {
                this.contextValue = isHeld ? 'slurmJobPendingArrayHeld' : 'slurmJobPendingArray';
            } else {
                this.contextValue = isHeld ? 'slurmJobPendingHeld' : 'slurmJobPending';
            }
        } else {
            this.contextValue = isMainJobArray ? 'slurmJobArray' : 'slurmJob';
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

            // The priority breakdown is what actually answers "why is this job
            // still queued" for jobs waiting on Priority.
            if (this.priorityFactors) {
                details.push(...formatJobPriorityDetails(this.priorityFactors));
            }
        }

        if (isNearTimeLimit(this.job)) {
            details.push({
                label: 'Remaining',
                value: formatRemainingTime(calculateRemainingSeconds(this.job.time, this.job.timeLimit)),
            });
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

        // sprio only reports queued jobs, so this is pending-only in practice —
        // scoped explicitly so it stays that way.
        const dominantComponent = this.job.state === 'PD' && this.priorityFactors
            ? getDominantPriorityComponent(this.priorityFactors)
            : undefined;

        return new vscode.MarkdownString(formatTooltipMarkdown({
            title: `Job: ${this.job.name}`,
            summary: `${getStateDescription(this.job.state)} · ${this.job.jobId}`,
            details,
            sections,
            note: dominantComponent
                ? `${dominantComponent} contributes most to this job's priority.`
                : undefined,
        }));
    }

    private getStateIcon(dependency: DependencyStatus | undefined): vscode.ThemeIcon {
        // A job that can never start, held or not: releasing it would not help.
        // Its group's header is red already, so the rows aren't
        if (dependency?.kind === 'never') {
            return new vscode.ThemeIcon('circle-slash');
        }

        // Held pending jobs take priority — show lock icon
        if (this.job.state === 'PD' && isJobHeld(this.job.pendingReason)) {
            return new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.orange'));
        }

        // A running job about to be killed by its wall clock reads as healthy
        // green otherwise, which is the one case where that is misleading.
        if (isNearTimeLimit(this.job)) {
            return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.orange'));
        }

        switch (this.job.state) {
            case 'R':  // Running
                return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.green'));
            case 'CF': // Configuring
                return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.green'));
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
export class SubmitScriptItem extends vscode.TreeItem {
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

        // Make the item clickable to open the file. Scripts open from this machine,
        // editable, also when connected to a cluster: the file system is shared,
        // and the cached copy is kept here
        this.command = {
            command: 'slurmJobs.openFile',
            title: 'Open File',
            arguments: [filePath, { onThisMachine: true }],
        };
    }
}

/**
 * Header row showing the current user's Fair Tree standing, so the reason jobs
 * sit behind other people's is visible without opening a terminal.
 */
class FairShareItem extends vscode.TreeItem {
    constructor(summary: FairShareSummary) {
        super(formatFairShareHeaderLabel(summary), vscode.TreeItemCollapsibleState.None);
        this.description = summary.account;
        this.tooltip = new vscode.MarkdownString(formatFairShareTooltip(summary));
        this.contextValue = 'fairShare';
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
 * Header row with the GPUs the user's running jobs hold, so they can see how
 * much of the cluster they are using.
 */
class UserGpuUsageItem extends vscode.TreeItem {
    constructor(usage: UserGpuUsage) {
        super(`GPUs in use: ${usage.gpuCount}`, vscode.TreeItemCollapsibleState.None);
        // Same icon as the GPU line in job details
        this.iconPath = new vscode.ThemeIcon('circuit-board');
        this.description = formatGpuTypeBreakdown(usage);
        const jobs = (count: number) => `${count} running job${count === 1 ? '' : 's'}`;
        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title: 'GPUs in use',
            summary: usage.gpuCount === 0
                ? 'Your running jobs hold no GPUs.'
                : `${usage.gpuCount} GPU${usage.gpuCount === 1 ? '' : 's'} held by your ${jobs(usage.jobCount)}.`,
            details: usage.types.map(({ type, gpuCount, jobCount }) => ({ label: type, value: `${gpuCount} (${jobs(jobCount)})` })),
        }));
        this.contextValue = 'userGpuUsage';
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
    private checkedJobIds?: Set<string>;
    private cachedJobs: SlurmJob[] = [];
    private cachedDependencies: QueueDependencies | undefined;
    private cachedMaintenanceWindows: MaintenanceWindow[] = [];
    private cachedFairShareSummary: FairShareSummary | undefined;
    private cachedPriorityFactors: Map<string, JobPriorityFactors> | undefined;
    private hasFetchedFairShare = false;
    private searchFilter: string = '';
    private lastRefreshedAt: Date | undefined;
    // Disables the view's refresh button while it loads (package.json `enablement`)
    private readonly refreshGate = new RefreshGate<vscode.TreeItem[]>(
        () => this.reload(),
        (refreshing) => void vscode.commands.executeCommand('setContext', 'slurmJobs.refreshing', refreshing),
    );
    /** Shows when the data was fetched in its title bar */
    view: vscode.TreeView<vscode.TreeItem> | undefined;

    private currentUsernameProvider: () => string | undefined;

    constructor(
        slurmService: SlurmService,
        scriptCache?: SubmitScriptCache,
        checkedJobIds?: Set<string>,
        currentUsernameProvider?: () => string | undefined,
    ) {
        this.slurmService = slurmService;
        this.scriptCache = scriptCache;
        this.checkedJobIds = checkedJobIds;
        // The service knows who the user is on the cluster commands run on
        this.currentUsernameProvider = currentUsernameProvider ?? (() => slurmService.getUsername());
    }

    /**
     * Refresh the job list, once the refresh in progress (if any) is done
     */
    refresh(): void {
        this.refreshGate.refresh();
    }

    private reload(): void {
        this.cachedJobs = [];
        this.cachedMaintenanceWindows = [];
        this.cachedFairShareSummary = undefined;
        this.cachedPriorityFactors = undefined;
        this.hasFetchedFairShare = false;
        this.lastRefreshedAt = undefined;
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
     * Dependencies among the jobs the view shows, for cancelling: undefined
     * until they have first loaded. A refresh keeps the last ones until it has
     * new ones, so a cancel meanwhile still asks about the job's dependents.
     */
    getQueueDependencies(): QueueDependencies | undefined {
        return this.cachedDependencies;
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
            return this.getCategoryChildren(element);
        }

        // Root level: show categories
        return this.getRootItems();
    }

    /**
     * Return the root items, sharing a single fetch between concurrent callers.
     *
     * VS Code can ask for the root repeatedly in quick succession (for example when
     * several queued tree updates are rendered at once). Without this guard each of
     * those calls would kick off its own squeue/scontrol fan-out.
     */
    private getRootItems(): Promise<vscode.TreeItem[]> {
        return this.refreshGate.load(async () => {
            const items = await this.loadRootItems();
            showRefreshTime(this.view, this.lastRefreshedAt);
            return items;
        });
    }

    private async loadRootItems(): Promise<vscode.TreeItem[]> {
        try {
            // Check if SLURM is available
            const isAvailable = await this.slurmService.isAvailable();
            if (!isAvailable) {
                this.lastRefreshedAt = undefined;
                return [new MessageItem('SLURM not available on this system', 'warning')];
            }

            // Fetch and cache jobs only if cache is empty
            if (this.cachedJobs.length === 0) {
                const [jobs, maintenanceWindows] = await Promise.all([
                    this.slurmService.getJobs(),
                    this.slurmService.getMaintenanceWindows(),
                ]);

                this.cachedJobs = jobs;
                this.cachedDependencies = new QueueDependencies(jobs);
                this.cachedMaintenanceWindows = maintenanceWindows;
                this.lastRefreshedAt = new Date();

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

            const config = vscode.workspace.getConfiguration('slurmClusterManager');
            let fairShareItem: FairShareItem | null = null;

            if (config.get<boolean>('showFairShare', true)) {
                try {
                    // Cached alongside the jobs, and sourced from the service's
                    // shared sshare cache, so re-rendering costs nothing.
                    if (!this.hasFetchedFairShare) {
                        const hasPendingJobs = this.cachedJobs.some(job => job.state === 'PD');
                        const [fairShare, defaultAccount, priorityFactors] = await Promise.all([
                            this.slurmService.getFairShare(),
                            // Jobs are charged to it unless they pass --account
                            this.slurmService.getDefaultAccount(),
                            // sprio only describes queued jobs — skip it when nothing is pending.
                            hasPendingJobs
                                ? this.slurmService.getJobPriorityFactors()
                                : Promise.resolve(new Map<string, JobPriorityFactors>()),
                        ]);

                        const lookup = buildFairShareLookup(fairShare.entries);
                        // The standing that applies is the account the jobs run under, not the user's best one
                        this.cachedFairShareSummary = getFairShareSummary(lookup, this.currentUsernameProvider(), {
                            jobAccounts: rankJobAccounts(this.cachedJobs),
                            defaultAccount,
                        });
                        this.cachedPriorityFactors = priorityFactors;
                        this.hasFetchedFairShare = true;
                    }

                    fairShareItem = this.cachedFairShareSummary
                        ? new FairShareItem(this.cachedFairShareSummary)
                        : null;
                } catch (e) {
                    console.error('Failed to fetch fair share:', e);
                }
            }

            const maintenanceItem = createMaintenanceWarningItem(this.cachedMaintenanceWindows);
            // All of the user's jobs, whatever the search shows
            const gpuUsageItem = new UserGpuUsageItem(summarizeRunningGpus(this.cachedJobs));

            // Create category items
            const categories: vscode.TreeItem[] = [];

            // Add maintenance warning, GPUs in use and fair share at the top
            if (maintenanceItem) { categories.push(maintenanceItem); }
            categories.push(gpuUsageItem);
            if (fairShareItem) { categories.push(fairShareItem); }

            if (filteredJobs.length === 0 && this.searchFilter && this.cachedJobs.length > 0) {
                categories.push(new MessageItem(`No jobs matching "${this.searchFilter}"`, 'search'));
            }

            const jobsByCategory = new Map<ActiveJobCategory, SlurmJob[]>();
            for (const job of filteredJobs) {
                const category = getActiveJobCategory(job, this.cachedDependencies?.describe(job));
                if (!category) {
                    continue;
                }
                const jobs = jobsByCategory.get(category);
                if (jobs) {
                    jobs.push(job);
                } else {
                    jobsByCategory.set(category, [job]);
                }
            }
            for (const category of Object.keys(CATEGORIES) as ActiveJobCategory[]) {
                const jobs = jobsByCategory.get(category);
                if (jobs || ALWAYS_SHOWN_CATEGORIES.has(category)) {
                    categories.push(new StatusCategoryItem(category, jobs ?? [], this.cachedDependencies));
                }
            }

            return categories;
        } catch (error) {
            console.error('Error fetching SLURM jobs:', error);
            // With no refresh before it (it refetches while it has no jobs), the time would be the last load's
            this.lastRefreshedAt = undefined;
            return [new MessageItem('Error fetching jobs', 'error')];
        }
    }

    private getCategoryChildren(category: StatusCategoryItem): vscode.TreeItem[] {
        // The category's own jobs, not the cache: a refresh asked for while it loaded
        // may have dropped the cache by the time VS Code asks for its children
        const jobs = [...category.jobs];
        if (jobs.length === 0) {
            return [new MessageItem(`No ${CATEGORIES[category.category].label.toLowerCase()} jobs`, 'info')];
        }

        // Sort jobs by job ID (descending - newest first)
        jobs.sort((a, b) => parseInt(b.jobId) - parseInt(a.jobId));

        return jobs.map(job => new SlurmJobItem(
            job,
            this.checkedJobIds?.has(job.jobId) ?? false,
            findJobPriorityFactors(this.cachedPriorityFactors, job.jobId),
            category.dependencies?.describe(job),
        ));
    }

    private getJobChildren(job: SlurmJob): vscode.TreeItem[] {
        const children: vscode.TreeItem[] = [];
        const isPending = job.state === 'PD';

        // Add job details
        children.push(new JobDetailItem('Partition', job.partition, 'server'));

        // Pending: how long so far; started: how long it waited
        if (job.queuedSeconds !== undefined) {
            children.push(new JobDetailItem('Queued', formatDuration(job.queuedSeconds), 'history'));
        }

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
            const cluster = this.slurmService.getAccount().cluster;
            if (this.scriptCache && this.scriptCache.has(job.jobId, cluster)) {
                const cachedPath = this.scriptCache.getCachedScriptPath(job.jobId, cluster);
                const cachedAt = this.scriptCache.formatCacheTime(job.jobId, cluster);
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
