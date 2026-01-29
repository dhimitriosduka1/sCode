import * as vscode from 'vscode';
import { SlurmJobProvider } from './slurmJobProvider';
import { JobHistoryProvider } from './jobHistoryProvider';
import { SlurmService } from './slurmService';
import { JobPathCache } from './jobPathCache';
import { SubmitScriptCache } from './submitScriptCache';
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
    jobHistoryProvider: JobHistoryProvider
): void {
    // Clear existing timer
    stopAutoRefresh();

    const { enabled, interval } = getAutoRefreshConfig();

    if (enabled && interval >= 5) {
        autoRefreshTimer = setInterval(() => {
            slurmJobProvider.refresh();
            jobHistoryProvider.refresh();
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

    // Create shared SlurmService with caches
    const slurmService = new SlurmService(jobPathCache, submitScriptCache);

    // Create the job provider with shared service and script cache
    const slurmJobProvider = new SlurmJobProvider(slurmService, submitScriptCache);

    // Create the history provider with shared service
    const jobHistoryProvider = new JobHistoryProvider(slurmService);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem);

    // Register the Jobs TreeView
    const treeView = vscode.window.createTreeView('slurmJobs', {
        treeDataProvider: slurmJobProvider,
        showCollapseAll: true,
    });

    // Register the History TreeView
    const historyTreeView = vscode.window.createTreeView('slurmHistory', {
        treeDataProvider: jobHistoryProvider,
        showCollapseAll: true,
    });

    // Register the refresh command
    const refreshCommand = vscode.commands.registerCommand('slurmJobs.refresh', () => {
        slurmJobProvider.refresh();
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
            startAutoRefresh(slurmJobProvider, jobHistoryProvider);
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
                        label: '$(trash) Cancel entire job array',
                        description: `Cancel all jobs in array ${baseJobId}`,
                        value: 'entire'
                    },
                    {
                        label: '$(edit) Cancel specific job',
                        description: `Cancel a specific job within array ${baseJobId}`,
                        value: 'specific'
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
            } else {
                // Ask for specific job index
                const specificJobId = await vscode.window.showInputBox({
                    prompt: 'Enter the specific job ID to cancel',
                    placeHolder: `${baseJobId}_0`,
                    value: `${baseJobId}_`,
                    validateInput: (value) => {
                        if (!value.startsWith(`${baseJobId}_`)) {
                            return `Job ID must start with ${baseJobId}_`;
                        }
                        const index = value.substring(baseJobId.length + 1);
                        if (!index || !/^\d+$/.test(index)) {
                            return 'Please enter a valid job array index (e.g., 0, 1, 2, ...)';
                        }
                        return null;
                    }
                });

                if (!specificJobId) {
                    return; // User cancelled the input
                }

                jobIdToCancel = specificJobId;
            }
        }

        // Show confirmation dialog if enabled
        if (confirmCancel) {
            const confirmMessage = isJobArray && jobIdToCancel === jobId.split('_')[0]
                ? `Are you sure you want to cancel the ENTIRE job array "${jobName}" (${jobIdToCancel})?`
                : `Are you sure you want to cancel job "${jobName}" (${jobIdToCancel})?`;

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
