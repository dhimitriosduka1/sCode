import * as vscode from 'vscode';
import { SlurmJobProvider, SlurmJobItem } from './slurmJobProvider';
import { JobHistoryProvider } from './jobHistoryProvider';
import { SlurmService } from './slurmService';
import { JobPathCache } from './jobPathCache';
import { SubmitScriptCache } from './submitScriptCache';
import { PinnedJobsCache } from './pinnedJobsCache';
import * as fs from 'fs';

// Auto-refresh timer
let autoRefreshTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem;

/**
 * Get autorefresh configuration
 */
function getAutoRefreshConfig(): { enabled: boolean; interval: number } {
    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    return {
        enabled: config.get<boolean>('autoRefreshEnabled', false),
        interval: config.get<number>('autoRefreshInterval', 30),
    };
}

/**
 * Update status bar with autorefresh state
 */
function updateStatusBar(enabled: boolean, interval: number): void {
    if (enabled) {
        statusBarItem.text = `$(sync~spin) SLURM: ${interval}s`;
        statusBarItem.tooltip = `Auto-refresh enabled (every ${interval}s). Click to disable.`;
        statusBarItem.command = 'slurmJobs.toggleAutoRefresh';
        statusBarItem.show();
    } else {
        statusBarItem.text = `$(sync) SLURM: Off`;
        statusBarItem.tooltip = 'Auto-refresh disabled. Click to enable.';
        statusBarItem.command = 'slurmJobs.toggleAutoRefresh';
        statusBarItem.show();
    }
}

/**
 * Start or restart the autorefresh timer
 */
function startAutoRefresh(
    slurmJobProvider: SlurmJobProvider,
    jobHistoryProvider: JobHistoryProvider,
    checkedJobIds?: Set<string>
): void {
    // Clear existing timer
    stopAutoRefresh();

    const { enabled, interval } = getAutoRefreshConfig();

    if (enabled && interval >= 5) {
        autoRefreshTimer = setInterval(() => {
            slurmJobProvider.refresh();
            jobHistoryProvider.refresh();
            // Clear checked state on auto-refresh since tree items are rebuilt
            if (checkedJobIds) {
                checkedJobIds.clear();
                vscode.commands.executeCommand('setContext', 'slurmJobs.hasCheckedJobs', false);
            }
        }, interval * 1000);

        console.log(`Auto-refresh started: every ${interval} seconds`);
    }

    updateStatusBar(enabled, interval);
}

/**
 * Stop the autorefresh timer
 */
function stopAutoRefresh(): void {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = undefined;
    }
}

/**
 * Extension activation
 * Called when the extension is activated (e.g., when the SLURM view is opened)
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('SLURM Cluster Manager is now active');

    // Create the job path cache (persistent storage)
    const jobPathCache = new JobPathCache(context);

    // Create the submit script cache (persistent storage)
    const submitScriptCache = new SubmitScriptCache(context);

    // Create the pinned jobs cache (persistent storage)
    const pinnedJobsCache = new PinnedJobsCache(context);

    // Create shared SlurmService with caches
    const slurmService = new SlurmService(jobPathCache, submitScriptCache);

    // Create the job provider with shared service and caches
    const slurmJobProvider = new SlurmJobProvider(slurmService, submitScriptCache, pinnedJobsCache);

    // Create the history provider with shared service
    const jobHistoryProvider = new JobHistoryProvider(slurmService);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem);

    // Register the Jobs TreeView
    const treeView = vscode.window.createTreeView('slurmJobs', {
        treeDataProvider: slurmJobProvider,
        showCollapseAll: true,
        manageCheckboxStateManually: true,
    });

    // Track checked (selected) jobs for batch cancellation
    const checkedJobIds = new Set<string>();

    treeView.onDidChangeCheckboxState((e) => {
        for (const [item, state] of e.items) {
            if (item instanceof SlurmJobItem) {
                if (state === vscode.TreeItemCheckboxState.Checked) {
                    checkedJobIds.add(item.job.jobId);
                } else {
                    checkedJobIds.delete(item.job.jobId);
                }
            }
        }
        vscode.commands.executeCommand('setContext', 'slurmJobs.hasCheckedJobs', checkedJobIds.size > 0);
    });

    // Register the History TreeView
    const historyTreeView = vscode.window.createTreeView('slurmHistory', {
        treeDataProvider: jobHistoryProvider,
        showCollapseAll: true,
    });

    // Register the refresh command
    const refreshCommand = vscode.commands.registerCommand('slurmJobs.refresh', () => {
        slurmJobProvider.refresh();
        checkedJobIds.clear();
        vscode.commands.executeCommand('setContext', 'slurmJobs.hasCheckedJobs', false);
    });

    // Register the refresh history command
    const refreshHistoryCommand = vscode.commands.registerCommand('slurmHistory.refresh', () => {
        jobHistoryProvider.refresh();
    });

    // Register command to open output files
    const openFileCommand = vscode.commands.registerCommand('slurmJobs.openFile', async (filePath: string) => {
        if (!filePath || filePath === 'N/A') {
            vscode.window.showWarningMessage('File path not available');
            return;
        }

        try {
            // Check if file exists
            if (!fs.existsSync(filePath)) {
                // For pending jobs, the file might not exist yet
                vscode.window.showWarningMessage(`File not found: ${filePath}. The file may not exist yet if the job hasn't started.`);
                return;
            }

            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to open file: ${filePath}\n${errorMessage}`);
            console.error('Error opening file:', error);
        }
    });

    // Register command to open stdout file
    const openStdoutCommand = vscode.commands.registerCommand('slurmJobs.openStdout', async (item: any) => {
        if (item?.job?.stdoutPath) {
            await vscode.commands.executeCommand('slurmJobs.openFile', item.job.stdoutPath);
        }
    });

    // Register command to open stderr file
    const openStderrCommand = vscode.commands.registerCommand('slurmJobs.openStderr', async (item: any) => {
        if (item?.job?.stderrPath) {
            await vscode.commands.executeCommand('slurmJobs.openFile', item.job.stderrPath);
        }
    });

    // Register search command
    const searchCommand = vscode.commands.registerCommand('slurmJobs.search', async () => {
        const currentFilter = slurmJobProvider.getSearchFilter();
        const searchTerm = await vscode.window.showInputBox({
            prompt: 'Search jobs by name or Job ID',
            placeHolder: 'Enter search term...',
            value: currentFilter,
        });

        if (searchTerm !== undefined) {
            if (searchTerm === '') {
                slurmJobProvider.clearSearchFilter();
                vscode.window.showInformationMessage('Search filter cleared');
            } else {
                slurmJobProvider.setSearchFilter(searchTerm);
                vscode.window.showInformationMessage(`Filtering jobs: "${searchTerm}"`);
            }
        }
    });

    // Register clear search command
    const clearSearchCommand = vscode.commands.registerCommand('slurmJobs.clearSearch', () => {
        slurmJobProvider.clearSearchFilter();
        vscode.window.showInformationMessage('Search filter cleared');
    });

    // Register history search command
    const searchHistoryCommand = vscode.commands.registerCommand('slurmHistory.search', async () => {
        const currentFilter = jobHistoryProvider.getSearchFilter();
        const searchTerm = await vscode.window.showInputBox({
            prompt: 'Search job history by name or Job ID',
            placeHolder: 'Enter search term...',
            value: currentFilter,
        });

        if (searchTerm !== undefined) {
            if (searchTerm === '') {
                jobHistoryProvider.clearSearchFilter();
                vscode.window.showInformationMessage('History search filter cleared');
            } else {
                jobHistoryProvider.setSearchFilter(searchTerm);
                vscode.window.showInformationMessage(`Filtering history: "${searchTerm}"`);
            }
        }
    });

    // Register clear history search command
    const clearSearchHistoryCommand = vscode.commands.registerCommand('slurmHistory.clearSearch', () => {
        jobHistoryProvider.clearSearchFilter();
        vscode.window.showInformationMessage('History search filter cleared');
    });

    // Register next page command
    const nextPageCommand = vscode.commands.registerCommand('slurmHistory.nextPage', () => {
        jobHistoryProvider.nextPage();
    });

    // Register previous page command
    const previousPageCommand = vscode.commands.registerCommand('slurmHistory.previousPage', () => {
        jobHistoryProvider.previousPage();
    });

    // Register toggle autorefresh command
    const toggleAutoRefreshCommand = vscode.commands.registerCommand('slurmJobs.toggleAutoRefresh', async () => {
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        const currentEnabled = config.get<boolean>('autoRefreshEnabled', false);
        await config.update('autoRefreshEnabled', !currentEnabled, vscode.ConfigurationTarget.Global);

        const newState = !currentEnabled ? 'enabled' : 'disabled';
        const interval = config.get<number>('autoRefreshInterval', 30);
        vscode.window.showInformationMessage(
            `Auto-refresh ${newState}${!currentEnabled ? ` (every ${interval}s)` : ''}`
        );
    });

    // Register set autorefresh interval command
    const setAutoRefreshIntervalCommand = vscode.commands.registerCommand('slurmJobs.setAutoRefreshInterval', async () => {
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        const currentInterval = config.get<number>('autoRefreshInterval', 30);

        const input = await vscode.window.showInputBox({
            prompt: 'Enter auto-refresh interval in seconds (5-3600)',
            placeHolder: 'e.g., 30',
            value: String(currentInterval),
            validateInput: (value) => {
                const num = parseInt(value, 10);
                if (isNaN(num) || num < 5 || num > 3600) {
                    return 'Please enter a number between 5 and 3600';
                }
                return null;
            },
        });

        if (input !== undefined) {
            const newInterval = parseInt(input, 10);
            await config.update('autoRefreshInterval', newInterval, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Auto-refresh interval set to ${newInterval} seconds`);
        }
    });

    // Listen for configuration changes to update autorefresh
    const configChangeListener = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('slurmClusterManager.autoRefreshEnabled') ||
            e.affectsConfiguration('slurmClusterManager.autoRefreshInterval')) {
            startAutoRefresh(slurmJobProvider, jobHistoryProvider, checkedJobIds);
        }
    });

    // Register cancel job command (uses the shared slurmService created above)
    const cancelJobCommand = vscode.commands.registerCommand('slurmJobs.cancelJob', async (item: any) => {
        if (!item?.job?.jobId) {
            vscode.window.showWarningMessage('No job selected');
            return;
        }

        const jobId = item.job.jobId;
        const jobName = item.job.name;
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        const confirmCancel = config.get<boolean>('confirmCancelJob', true);

        // Check if this is a job array (contains underscore)
        const isJobArray = jobId.includes('_');
        let jobIdToCancel = jobId;

        if (isJobArray) {
            // Extract base job ID (the part before the underscore)
            const baseJobId = jobId.split('_')[0];

            // Present options to the user
            const cancelOption = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(clock) Cancel only pending jobs',
                        description: `Cancel pending jobs in array ${baseJobId}, keep running ones`,
                        value: 'pending'
                    },
                    {
                        label: '$(edit) Cancel specific job(s)',
                        description: `Cancel specific jobs within array ${baseJobId}`,
                        value: 'specific'
                    },
                    {
                        label: '$(trash) Cancel entire job array',
                        description: `Cancel all jobs in array ${baseJobId}`,
                        value: 'entire'
                    }
                ],
                {
                    placeHolder: 'This is a job array. How would you like to cancel?',
                    title: `Cancel Job Array: ${jobName}`
                }
            );

            if (!cancelOption) {
                return; // User cancelled the selection
            }

            if (cancelOption.value === 'entire') {
                // Cancel the entire job array using the base ID
                jobIdToCancel = baseJobId;
            } else if (cancelOption.value === 'pending') {
                // Cancel only pending jobs in the array
                if (confirmCancel) {
                    const confirmation = await vscode.window.showWarningMessage(
                        `Are you sure you want to cancel all PENDING jobs in array "${jobName}" (${baseJobId})? Running jobs will not be affected.`,
                        { modal: true },
                        'Cancel Pending'
                    );

                    if (confirmation !== 'Cancel Pending') {
                        return;
                    }
                }

                const result = await slurmService.cancelJobByState(baseJobId, 'PENDING');

                if (result.success) {
                    vscode.window.showInformationMessage(result.message);
                    slurmJobProvider.refresh();
                } else {
                    vscode.window.showErrorMessage(result.message);
                }
                return; // Early return since we handled everything
            } else {
                // Get job array info for upper bound validation
                const arrayInfo = await slurmService.getJobArrayInfo(baseJobId);
                const maxArrayIndex = arrayInfo?.maxIndex;
                const minArrayIndex = arrayInfo?.minIndex ?? 0;

                // Ask for job indices with comprehensive validation
                const rangeInput = await vscode.window.showInputBox({
                    prompt: `Enter indices to cancel. Formats: single (3), range (0-5), step (0-10:2), or list (1,3,5)${maxArrayIndex !== undefined ? ` [Array range: ${minArrayIndex}-${maxArrayIndex}]` : ''}`,
                    placeHolder: '3 or 0-10 or 0-20:2 or 1,3,5,7',
                    validateInput: (value) => {
                        // Check for single index: just a number
                        if (/^\d+$/.test(value)) {
                            const index = parseInt(value, 10);
                            if (maxArrayIndex !== undefined && (index < minArrayIndex || index > maxArrayIndex)) {
                                return `Index out of range (valid: ${minArrayIndex}-${maxArrayIndex})`;
                            }
                            return null;
                        }

                        // Check for comma-separated indices format: 1,3,5,7
                        const commaPattern = /^(\d+)(,\d+)+$/;
                        if (commaPattern.test(value)) {
                            const indices = value.split(',').map(n => parseInt(n, 10));

                            // Check for duplicates
                            const uniqueIndices = new Set(indices);
                            if (uniqueIndices.size !== indices.length) {
                                return 'Duplicate indices detected';
                            }

                            // Check upper bound
                            if (maxArrayIndex !== undefined) {
                                const outOfBounds = indices.filter(i => i < minArrayIndex || i > maxArrayIndex);
                                if (outOfBounds.length > 0) {
                                    return `Indices out of range (valid: ${minArrayIndex}-${maxArrayIndex}): ${outOfBounds.join(', ')}`;
                                }
                            }

                            // Check max count warning threshold
                            if (indices.length > 100) {
                                return `Warning: This will cancel ${indices.length} jobs. Consider using a range instead.`;
                            }

                            return null;
                        }

                        // Check for range with optional step format: start-end or start-end:step
                        const rangeMatch = value.match(/^(\d+)-(\d+)(?::(\d+))?$/);
                        if (!rangeMatch) {
                            return 'Invalid format. Use: single (3), range (0-5), step (0-10:2), or list (1,3,5)';
                        }

                        const start = parseInt(rangeMatch[1], 10);
                        const end = parseInt(rangeMatch[2], 10);
                        const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;

                        // Validate start <= end
                        if (start > end) {
                            return 'Start index must be less than or equal to end index';
                        }

                        // Validate step > 0
                        if (step <= 0) {
                            return 'Step must be a positive number';
                        }

                        // Check upper bound against actual array
                        if (maxArrayIndex !== undefined) {
                            if (start < minArrayIndex) {
                                return `Start index ${start} is below array minimum (${minArrayIndex})`;
                            }
                            if (end > maxArrayIndex) {
                                return `End index ${end} exceeds array maximum (${maxArrayIndex})`;
                            }
                        }

                        // Calculate how many jobs this will cancel
                        const jobCount = Math.floor((end - start) / step) + 1;

                        // Warn if cancelling many jobs
                        if (jobCount > 100) {
                            return `This will cancel ${jobCount} jobs. Are you sure? Re-enter to confirm.`;
                        }

                        return null;
                    }
                });

                if (!rangeInput) {
                    return; // User cancelled the input
                }

                // Check if it's a single index (no brackets needed)
                if (/^\d+$/.test(rangeInput)) {
                    jobIdToCancel = `${baseJobId}_${rangeInput}`;
                } else {
                    // Large range warning - show additional confirmation for >100 jobs
                    const commaPattern = /^(\d+)(,\d+)+$/;
                    let jobCount = 0;
                    if (commaPattern.test(rangeInput)) {
                        jobCount = rangeInput.split(',').length;
                    } else {
                        const rangeMatch = rangeInput.match(/^(\d+)-(\d+)(?::(\d+))?$/);
                        if (rangeMatch) {
                            const start = parseInt(rangeMatch[1], 10);
                            const end = parseInt(rangeMatch[2], 10);
                            const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
                            jobCount = Math.floor((end - start) / step) + 1;
                        }
                    }

                    if (jobCount > 100) {
                        const largeRangeConfirm = await vscode.window.showWarningMessage(
                            `You are about to cancel ${jobCount} jobs. Are you sure?`,
                            { modal: true },
                            'Yes, Cancel All'
                        );
                        if (largeRangeConfirm !== 'Yes, Cancel All') {
                            return;
                        }
                    }

                    // scancel uses bracket syntax: jobId_[start-end] or jobId_[1,3,5]
                    // However, scancel does NOT support step notation (e.g., 0-10:2),
                    // so we expand stepped ranges into comma-separated indices
                    let scancelRange = rangeInput;
                    const stepMatch = rangeInput.match(/^(\d+)-(\d+):(\d+)$/);
                    if (stepMatch) {
                        const start = parseInt(stepMatch[1], 10);
                        const end = parseInt(stepMatch[2], 10);
                        const step = parseInt(stepMatch[3], 10);
                        const indices: number[] = [];
                        for (let i = start; i <= end; i += step) {
                            indices.push(i);
                        }
                        scancelRange = indices.join(',');
                    }
                    jobIdToCancel = `${baseJobId}_[${scancelRange}]`;
                }
            }
        }

        // Show confirmation dialog if enabled
        if (confirmCancel) {
            let confirmMessage: string;
            if (isJobArray && jobIdToCancel === jobId.split('_')[0]) {
                confirmMessage = `Are you sure you want to cancel the ENTIRE job array "${jobName}" (${jobIdToCancel})?`;
            } else if (isJobArray && jobIdToCancel.includes('[')) {
                confirmMessage = `Are you sure you want to cancel jobs "${jobName}" in range ${jobIdToCancel}?`;
            } else {
                confirmMessage = `Are you sure you want to cancel job "${jobName}" (${jobIdToCancel})?`;
            }

            const confirmation = await vscode.window.showWarningMessage(
                confirmMessage,
                { modal: true },
                'Cancel Job'
            );

            if (confirmation !== 'Cancel Job') {
                return; // User cancelled the dialog
            }
        }

        // Cancel the job
        const result = await slurmService.cancelJob(jobIdToCancel);

        if (result.success) {
            vscode.window.showInformationMessage(result.message);
            // Refresh the job list to reflect the change
            slurmJobProvider.refresh();
        } else {
            vscode.window.showErrorMessage(result.message);
        }
    });

    // Register cancel all/selected jobs command (unified: cancels selected if any, otherwise all)
    const cancelAllJobsCommand = vscode.commands.registerCommand('slurmJobs.cancelAllJobs', async () => {
        if (checkedJobIds.size > 0) {
            // Cancel only selected jobs
            const jobCount = checkedJobIds.size;
            const confirmation = await vscode.window.showWarningMessage(
                `Are you sure you want to cancel ${jobCount} selected job${jobCount > 1 ? 's' : ''}? This action cannot be undone.`,
                { modal: true },
                'Cancel Selected'
            );

            if (confirmation !== 'Cancel Selected') {
                return;
            }

            const results = await Promise.all(
                Array.from(checkedJobIds).map(jobId => slurmService.cancelJob(jobId))
            );

            const succeeded = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;

            if (failed === 0) {
                vscode.window.showInformationMessage(`Successfully cancelled ${succeeded} job${succeeded > 1 ? 's' : ''}.`);
            } else {
                vscode.window.showWarningMessage(
                    `Cancelled ${succeeded} job${succeeded > 1 ? 's' : ''}, ${failed} failed. Check the output for details.`
                );
            }

            checkedJobIds.clear();
            vscode.commands.executeCommand('setContext', 'slurmJobs.hasCheckedJobs', false);
            slurmJobProvider.refresh();
            jobHistoryProvider.refresh();
        } else {
            // Cancel all jobs
            const confirmation = await vscode.window.showWarningMessage(
                'Are you sure you want to cancel ALL your active jobs? This action cannot be undone.',
                { modal: true },
                'Cancel All Jobs'
            );

            if (confirmation !== 'Cancel All Jobs') {
                return;
            }

            const result = await slurmService.cancelAllJobs();

            if (result.success) {
                vscode.window.showInformationMessage(result.message);
                slurmJobProvider.refresh();
                jobHistoryProvider.refresh();
            } else {
                vscode.window.showErrorMessage(result.message);
            }
        }
    });

    // Register submit job command
    const submitJobCommand = vscode.commands.registerCommand('slurmJobs.submitJob', async () => {
        // Check if workspace is open
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showWarningMessage('Please open a workspace folder to submit jobs.');
            return;
        }

        // Find all potential SLURM script files in the workspace
        const scriptFiles = await vscode.workspace.findFiles(
            '**/*.{sh,slurm,sbatch}',
            '**/node_modules/**'
        );

        if (scriptFiles.length === 0) {
            vscode.window.showWarningMessage('No script files (.sh, .slurm, .sbatch) found in workspace.');
            return;
        }

        // Filter to only files containing #SBATCH directives (actual SLURM scripts)
        // Read files in parallel for speed
        const checkResults = await Promise.all(
            scriptFiles.map(async (uri) => {
                try {
                    const content = await fs.promises.readFile(uri.fsPath, 'utf8');
                    // Check first 2KB for #SBATCH to avoid reading huge files
                    const header = content.slice(0, 2048);
                    if (header.includes('#SBATCH')) {
                        return uri.fsPath;
                    }
                } catch {
                    // Skip files that can't be read
                }
                return null;
            })
        );

        const slurmScripts = checkResults.filter((path): path is string => path !== null);

        if (slurmScripts.length === 0) {
            vscode.window.showWarningMessage('No SLURM scripts (containing #SBATCH) found in workspace.');
            return;
        }

        // Sort by full path alphabetically and create QuickPick items
        slurmScripts.sort((a, b) => a.localeCompare(b));

        const items = slurmScripts.map(filePath => ({
            label: filePath,
            description: '',
        }));

        // Show QuickPick
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a SLURM script to submit',
            title: 'Submit SLURM Job',
        });

        if (!selected) {
            return; // User cancelled
        }

        const scriptPath = selected.label;

        // Submit the job
        const result = await slurmService.submitJob(scriptPath);

        if (result.success) {
            vscode.window.showInformationMessage(result.message);
            // Refresh the job list to show the new job
            slurmJobProvider.refresh();
            jobHistoryProvider.refresh();
        } else {
            vscode.window.showErrorMessage(result.message);
        }
    });

    // Register pin job command
    const pinJobCommand = vscode.commands.registerCommand('slurmJobs.pinJob', async (item: any) => {
        if (!item?.job?.jobId) {
            vscode.window.showWarningMessage('No job selected');
            return;
        }

        await pinnedJobsCache.pin(item.job.jobId);
        slurmJobProvider.refresh();
        vscode.window.showInformationMessage(`Pinned job: ${item.job.name}`);
    });

    // Register unpin job command
    const unpinJobCommand = vscode.commands.registerCommand('slurmJobs.unpinJob', async (item: any) => {
        if (!item?.job?.jobId) {
            vscode.window.showWarningMessage('No job selected');
            return;
        }

        await pinnedJobsCache.unpin(item.job.jobId);
        slurmJobProvider.refresh();
        vscode.window.showInformationMessage(`Unpinned job: ${item.job.name}`);
    });

    // Add disposables to context
    context.subscriptions.push(treeView);
    context.subscriptions.push(historyTreeView);
    context.subscriptions.push(refreshCommand);
    context.subscriptions.push(refreshHistoryCommand);
    context.subscriptions.push(openFileCommand);
    context.subscriptions.push(openStdoutCommand);
    context.subscriptions.push(openStderrCommand);
    context.subscriptions.push(searchCommand);
    context.subscriptions.push(clearSearchCommand);
    context.subscriptions.push(searchHistoryCommand);
    context.subscriptions.push(clearSearchHistoryCommand);
    context.subscriptions.push(nextPageCommand);
    context.subscriptions.push(previousPageCommand);
    context.subscriptions.push(toggleAutoRefreshCommand);
    context.subscriptions.push(setAutoRefreshIntervalCommand);
    context.subscriptions.push(configChangeListener);
    context.subscriptions.push(cancelJobCommand);
    context.subscriptions.push(cancelAllJobsCommand);
    context.subscriptions.push(submitJobCommand);
    context.subscriptions.push(pinJobCommand);
    context.subscriptions.push(unpinJobCommand);

    // Initialize autorefresh based on saved settings
    startAutoRefresh(slurmJobProvider, jobHistoryProvider);

    // Show welcome message on first activation
    vscode.window.showInformationMessage('SLURM Cluster Manager activated. View your jobs in the sidebar.');
}

/**
 * Extension deactivation
 * Called when the extension is deactivated
 */
export function deactivate() {
    stopAutoRefresh();
    console.log('SLURM Cluster Manager deactivated');
}
