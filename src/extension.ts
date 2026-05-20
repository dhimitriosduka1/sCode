import * as vscode from 'vscode';
import { SlurmJobProvider, SlurmJobItem } from './slurmJobProvider';
import { JobHistoryProvider } from './jobHistoryProvider';
import { PartitionUsageProvider } from './partitionUsageProvider';
import { ClusterOverviewProvider } from './clusterOverviewProvider';
import { LeaderboardProvider } from './leaderboardProvider';
import {
    DEFAULT_LEADERBOARD_ENTRY_COUNT,
    MAX_LEADERBOARD_ENTRY_COUNT,
    MIN_LEADERBOARD_ENTRY_COUNT,
    normalizeLeaderboardEntryCount,
} from './leaderboardRanking';
import { SlurmHoverProvider, SlurmDecorationProvider } from './slurmHoverProvider';
import { hasUnresolvedSlurmPathPlaceholders, normalizeOpenableFilePath, SlurmService, SlurmJob, getStateDescription } from './slurmService';
import { JobPathCache } from './jobPathCache';
import { SubmitScriptCache } from './submitScriptCache';
import { PinnedJobsCache } from './pinnedJobsCache';
import { parseSshConfigHosts } from './sshExecutor';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Auto-refresh timer
let autoRefreshTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem;
let activeSlurmService: SlurmService | undefined;
let sshConnectionState: 'local' | 'connecting' | 'online' | 'error' = 'local';

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
 * Check whether local mock data should be used instead of Slurm commands
 */
function isMockModeEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    return config.get<boolean>('mockMode', false);
}

/**
 * Update status bar with connection state and autorefresh state
 */
function updateStatusBar(enabled: boolean, interval: number): void {
    const refText = enabled ? `${interval}s` : 'Off';
    const refTooltip = enabled ? `every ${interval}s` : 'disabled';

    if (sshConnectionState === 'connecting') {
        statusBarItem.text = `$(sync~spin) SLURM: Connecting...`;
        statusBarItem.tooltip = `Connecting to remote SLURM cluster '${activeSlurmService?.getRemoteHost()}'... Click to troubleshoot connection.`;
        statusBarItem.command = 'slurmJobs.troubleshootConnection';
        statusBarItem.show();
    } else if (sshConnectionState === 'online') {
        const host = activeSlurmService?.getRemoteHost() || '';
        statusBarItem.text = `$(cloud) SLURM: ${host} (${refText})`;
        statusBarItem.tooltip = `Remote SLURM Cluster: ${host} (SSH multiplexed connection active).\nAuto-refresh is ${refTooltip}.\nClick to troubleshoot or configure connection.`;
        statusBarItem.command = 'slurmJobs.troubleshootConnection';
        statusBarItem.show();
    } else if (sshConnectionState === 'error') {
        const host = activeSlurmService?.getRemoteHost() || '';
        statusBarItem.text = `$(cloud-offline) SLURM: Conn Error (${host})`;
        statusBarItem.tooltip = `Failed to connect to remote SLURM cluster '${host}'.\nClick to troubleshoot connection.`;
        statusBarItem.command = 'slurmJobs.troubleshootConnection';
        statusBarItem.show();
    } else {
        // Local mode
        statusBarItem.text = `$(server) SLURM: Local (${refText})`;
        statusBarItem.tooltip = `SLURM Cluster Manager: Local Execution.\nAuto-refresh is ${refTooltip}.\nClick to configure remote SSH connection.`;
        statusBarItem.command = 'slurmJobs.troubleshootConnection';
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
            // Update context key after refresh (provider prunes stale checked IDs)
            if (checkedJobIds) {
                vscode.commands.executeCommand('setContext', 'slurmJobs.hasCheckedJobs', checkedJobIds.size > 0);
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

    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    const remoteHost = config.get<string>('remoteHost') || undefined;
    const remoteWorkDir = config.get<string>('remoteWorkDir') || undefined;

    // Create shared SlurmService with caches
    const slurmService = new SlurmService(
        jobPathCache,
        submitScriptCache,
        undefined,
        isMockModeEnabled,
        remoteHost,
        remoteWorkDir
    );
    activeSlurmService = slurmService;

    if (slurmService.isRemoteMode()) {
        sshConnectionState = 'connecting';
        slurmService.isAvailable().then(available => {
            sshConnectionState = available ? 'online' : 'error';
            const { enabled, interval } = getAutoRefreshConfig();
            updateStatusBar(enabled, interval);
        });
    } else {
        sshConnectionState = 'local';
    }

    // Track checked (selected) jobs for batch cancellation
    const checkedJobIds = new Set<string>();

    // Create the job provider with shared service and caches
    const slurmJobProvider = new SlurmJobProvider(slurmService, submitScriptCache, pinnedJobsCache, checkedJobIds);

    // Create the history provider with shared service
    const jobHistoryProvider = new JobHistoryProvider(slurmService);

    // Create the partition usage provider (no auto-refresh, manual only)
    const partitionUsageProvider = new PartitionUsageProvider(slurmService);

    // Create the cluster overview provider (no auto-refresh, manual only)
    const clusterOverviewProvider = new ClusterOverviewProvider(slurmService);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem);

    // Register the Jobs TreeView
    const treeView = vscode.window.createTreeView('slurmJobs', {
        treeDataProvider: slurmJobProvider,
        showCollapseAll: true,
        manageCheckboxStateManually: true,
    });

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

    // Register the Partition Usage TreeView
    const partitionUsageTreeView = vscode.window.createTreeView('slurmPartitionUsage', {
        treeDataProvider: partitionUsageProvider,
        showCollapseAll: false,
    });

    // Register the Cluster Overview TreeView
    const clusterOverviewTreeView = vscode.window.createTreeView('slurmClusterOverview', {
        treeDataProvider: clusterOverviewProvider,
        showCollapseAll: false,
    });

    // Create the leaderboard provider (no auto-refresh, manual only)
    const leaderboardProvider = new LeaderboardProvider(slurmService);

    // Register the Leaderboard TreeView
    const leaderboardTreeView = vscode.window.createTreeView('slurmLeaderboard', {
        treeDataProvider: leaderboardProvider,
        showCollapseAll: false,
    });


    // Detect SLURM scripts and set context key for editor title button
    function updateSlurmScriptContext(editor?: vscode.TextEditor) {
        if (!editor) {
            vscode.commands.executeCommand('setContext', 'slurmJobs.isSlurmScript', false);
            return;
        }
        const text = editor.document.getText(
            new vscode.Range(0, 0, Math.min(editor.document.lineCount, 50), 0)
        );
        const isSlurmScript = text.includes('#SBATCH');
        vscode.commands.executeCommand('setContext', 'slurmJobs.isSlurmScript', isSlurmScript);
    }

    // Check on activation and editor changes
    updateSlurmScriptContext(vscode.window.activeTextEditor);
    const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(updateSlurmScriptContext);
    const docChangeListener = vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor?.document === e.document) {
            updateSlurmScriptContext(vscode.window.activeTextEditor);
        }
    });

    // Register hover provider for partition stats on hover
    const hoverProvider = vscode.languages.registerHoverProvider(
        [
            { scheme: 'file', language: 'shellscript' },
            { scheme: 'file', language: 'plaintext' },
            { scheme: 'file', pattern: '**/*.{slurm,sbatch}' },
        ],
        new SlurmHoverProvider(slurmService)
    );

    // Underline decorations for hoverable partition names
    const decorationProvider = new SlurmDecorationProvider();
    decorationProvider.updateDecorations(vscode.window.activeTextEditor);
    const decorEditorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        decorationProvider.updateDecorations(editor);
    });
    const decorDocListener = vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor?.document === e.document) {
            decorationProvider.updateDecorations(vscode.window.activeTextEditor);
        }
    });

    // Register the refresh command
    const refreshCommand = vscode.commands.registerCommand('slurmJobs.refresh', () => {
        slurmJobProvider.refresh();
        // Update context key after refresh (provider prunes stale checked IDs)
        // Use setTimeout to let the tree data provider finish its async work
        setTimeout(() => {
            vscode.commands.executeCommand('setContext', 'slurmJobs.hasCheckedJobs', checkedJobIds.size > 0);
        }, 500);
    });

    // Register the refresh history command
    const refreshHistoryCommand = vscode.commands.registerCommand('slurmHistory.refresh', () => {
        jobHistoryProvider.refresh();
    });

    // Register the refresh partition usage command
    const refreshPartitionUsageCommand = vscode.commands.registerCommand('slurmPartitionUsage.refresh', () => {
        partitionUsageProvider.refresh();
    });

    // Register the refresh cluster overview command
    const refreshClusterOverviewCommand = vscode.commands.registerCommand('slurmClusterOverview.refresh', () => {
        clusterOverviewProvider.refresh();
    });

    // Register the refresh leaderboard command
    const refreshLeaderboardCommand = vscode.commands.registerCommand('slurmLeaderboard.refresh', () => {
        leaderboardProvider.refresh();
    });

    const setLeaderboardTopUserCountCommand = vscode.commands.registerCommand('slurmLeaderboard.setTopUserCount', async () => {
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        const currentCount = normalizeLeaderboardEntryCount(
            config.get<number>('leaderboardTopUserCount', DEFAULT_LEADERBOARD_ENTRY_COUNT)
        );

        const input = await vscode.window.showInputBox({
            prompt: `Enter how many top GPU users to show (${MIN_LEADERBOARD_ENTRY_COUNT}-${MAX_LEADERBOARD_ENTRY_COUNT})`,
            placeHolder: 'e.g., 10',
            value: String(currentCount),
            validateInput: (value) => {
                const num = Number(value);
                if (!Number.isInteger(num) ||
                    num < MIN_LEADERBOARD_ENTRY_COUNT ||
                    num > MAX_LEADERBOARD_ENTRY_COUNT) {
                    return `Please enter a whole number between ${MIN_LEADERBOARD_ENTRY_COUNT} and ${MAX_LEADERBOARD_ENTRY_COUNT}`;
                }
                return null;
            },
        });

        if (input !== undefined) {
            const newCount = normalizeLeaderboardEntryCount(Number(input));
            await config.update('leaderboardTopUserCount', newCount, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(
                `Hall of Shame will show the top ${newCount} GPU user${newCount === 1 ? '' : 's'}`
            );
        }
    });

    // Register command to open output files
    const openFileCommand = vscode.commands.registerCommand('slurmJobs.openFile', async (filePath: string) => {
        const normalizedFilePath = normalizeOpenableFilePath(
            filePath,
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        );

        if (!normalizedFilePath) {
            vscode.window.showWarningMessage('File path not available');
            return;
        }

        if (hasUnresolvedSlurmPathPlaceholders(normalizedFilePath) || normalizedFilePath.includes('PENDING_NODE')) {
            vscode.window.showWarningMessage(
                `Output path is not fully resolved yet: ${normalizedFilePath}. Refresh after the job starts or finishes.`
            );
            return;
        }

        if (slurmService.isRemoteMode()) {
            const sshExecutor = slurmService.getSshExecutor();
            if (!sshExecutor) {
                vscode.window.showErrorMessage('SSH connection is not initialized.');
                return;
            }

            try {
                // Show intuitive loading progress
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Fetching remote file: ${path.basename(normalizedFilePath)}`,
                    cancellable: false
                }, async () => {
                    // Check remote file exists & is not directory
                    let fileStat;
                    try {
                        fileStat = await sshExecutor.stat(normalizedFilePath);
                    } catch {
                        throw new Error(`File not found on remote cluster. The file may not exist yet if the job hasn't started.`);
                    }

                    if (fileStat.isDirectory) {
                        throw new Error(`Path is a directory, not a file.`);
                    }

                    // Read content
                    const content = await sshExecutor.readFile(normalizedFilePath);

                    // Create remote logs temp directory locally
                    const tempDir = path.join(os.tmpdir(), 'vscode-slurm-remote-logs');
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }

                    // Write to local temp file (retaining original basename)
                    const tempFilePath = path.join(tempDir, path.basename(normalizedFilePath));
                    fs.writeFileSync(tempFilePath, content, 'utf8');

                    // Open the local temp file
                    const uri = vscode.Uri.file(tempFilePath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, { preview: true });
                });
            } catch (error: any) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to open remote file: ${errorMessage}`);
            }
            return;
        }

        // Local execution flow
        try {
            // Check if file exists
            if (!fs.existsSync(normalizedFilePath)) {
                // For pending jobs, the file might not exist yet
                vscode.window.showWarningMessage(`File not found: ${normalizedFilePath}. The file may not exist yet if the job hasn't started.`);
                return;
            }

            const stat = fs.statSync(normalizedFilePath);
            if (stat.isDirectory()) {
                vscode.window.showWarningMessage(`Output path is a directory, not a file: ${normalizedFilePath}`);
                return;
            }

            const uri = vscode.Uri.file(normalizedFilePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to open file: ${normalizedFilePath}\n${errorMessage}`);
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
            prompt: 'Search Job History by name or Job ID',
            placeHolder: 'Enter search term...',
            value: currentFilter,
        });

        if (searchTerm !== undefined) {
            if (searchTerm === '') {
                jobHistoryProvider.clearSearchFilter();
                vscode.window.showInformationMessage('Job History search filter cleared');
            } else {
                jobHistoryProvider.setSearchFilter(searchTerm);
                vscode.window.showInformationMessage(`Filtering Job History: "${searchTerm}"`);
            }
        }
    });

    // Register clear history search command
    const clearSearchHistoryCommand = vscode.commands.registerCommand('slurmHistory.clearSearch', () => {
        jobHistoryProvider.clearSearchFilter();
        vscode.window.showInformationMessage('Job History search filter cleared');
    });

    // Register history range command
    const setHistoryRangeCommand = vscode.commands.registerCommand('slurmHistory.setRange', async () => {
        const currentDays = jobHistoryProvider.getHistoryDays();
        const selected = await vscode.window.showQuickPick(
            [
                { label: 'Last 1 day', description: 'Show jobs from the last day', days: 1 },
                { label: 'Last 7 days', description: 'Show jobs from the last week', days: 7 },
                { label: 'Last 30 days', description: 'Show jobs from the last month', days: 30 },
                { label: 'Custom...', description: 'Enter a custom range from 1 to 365 days', days: undefined },
            ],
            {
                placeHolder: `Current range: last ${currentDays} day${currentDays === 1 ? '' : 's'}`,
                title: 'Set Job History Range',
            }
        );

        if (!selected) {
            return;
        }

        let newDays = selected.days;
        if (newDays === undefined) {
            const input = await vscode.window.showInputBox({
                prompt: 'Enter Job History range in days (1-365)',
                placeHolder: 'e.g., 14',
                value: String(currentDays),
                validateInput: (value) => {
                    const num = Number(value);
                    if (!Number.isInteger(num) || num < 1 || num > 365) {
                        return 'Please enter a whole number between 1 and 365';
                    }
                    return null;
                },
            });

            if (input === undefined) {
                return;
            }

            newDays = Number(input);
        }

        jobHistoryProvider.setHistoryDays(newDays);
        vscode.window.showInformationMessage(`Job History range set to last ${newDays} day${newDays === 1 ? '' : 's'}`);
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

        if (e.affectsConfiguration('slurmClusterManager.mockMode')) {
            checkedJobIds.clear();
            vscode.commands.executeCommand('setContext', 'slurmJobs.hasCheckedJobs', false);
            slurmJobProvider.refresh();
            jobHistoryProvider.refresh();
            clusterOverviewProvider.refresh();
            leaderboardProvider.refresh();
        }

        if (e.affectsConfiguration('slurmClusterManager.leaderboardTopUserCount')) {
            leaderboardProvider.rerender();
        }

        if (e.affectsConfiguration('slurmClusterManager.remoteHost') ||
            e.affectsConfiguration('slurmClusterManager.remoteWorkDir')) {
            const currentConfig = vscode.workspace.getConfiguration('slurmClusterManager');
            const newHost = currentConfig.get<string>('remoteHost') || undefined;
            const newWorkDir = currentConfig.get<string>('remoteWorkDir') || undefined;
            sshConnectionState = newHost ? 'connecting' : 'local';
            const { enabled, interval } = getAutoRefreshConfig();
            updateStatusBar(enabled, interval);
            slurmService.updateRemoteConfig(newHost, newWorkDir).then(() => {
                if (slurmService.isRemoteMode()) {
                    slurmService.isAvailable().then(available => {
                        sshConnectionState = available ? 'online' : 'error';
                        updateStatusBar(enabled, interval);
                        slurmJobProvider.refresh();
                        jobHistoryProvider.refresh();
                        partitionUsageProvider.refresh();
                        clusterOverviewProvider.refresh();
                        leaderboardProvider.refresh();
                    });
                } else {
                    slurmJobProvider.refresh();
                    jobHistoryProvider.refresh();
                    partitionUsageProvider.refresh();
                    clusterOverviewProvider.refresh();
                    leaderboardProvider.refresh();
                }
            });
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
        const jobState = item.job.state;
        let jobIdToCancel = jobId;

        // Only show array-level cancel options for pending jobs.
        // Running job array tasks are treated as individual jobs since
        // they already have a specific array index assigned.
        if (isJobArray && jobState === 'PD') {
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

    // Register cancel all pending jobs command
    const cancelAllPendingJobsCommand = vscode.commands.registerCommand('slurmJobs.cancelAllPendingJobs', async () => {
        const confirmation = await vscode.window.showWarningMessage(
            'Are you sure you want to cancel ALL your pending jobs? Running jobs will be kept.',
            { modal: true },
            'Cancel Pending Jobs'
        );

        if (confirmation !== 'Cancel Pending Jobs') {
            return;
        }

        const result = await slurmService.cancelAllPendingJobs();

        if (result.success) {
            vscode.window.showInformationMessage(result.message);
            slurmJobProvider.refresh();
            jobHistoryProvider.refresh();
        } else {
            vscode.window.showErrorMessage(result.message);
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

        // Get job dependencies if configured
        const dependency = await promptAndGetDependencyString(slurmService);
        if (dependency === null) {
            return; // User cancelled
        }

        // Submit the job
        let result;
        if (slurmService.isRemoteMode()) {
            result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Submitting job remotely to '${slurmService.getRemoteHost()}'...`,
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Copying script and submitting via sbatch...' });
                return await slurmService.submitJob(scriptPath, undefined, dependency);
            });
        } else {
            result = await slurmService.submitJob(scriptPath, undefined, dependency);
        }

        if (result.success) {
            vscode.window.showInformationMessage(result.message);
            // Refresh the job list to show the new job
            slurmJobProvider.refresh();
            jobHistoryProvider.refresh();
        } else {
            vscode.window.showErrorMessage(result.message);
        }
    });

    // Register submit current file command (for CodeLens)
    const submitCurrentFileCommand = vscode.commands.registerCommand('slurmJobs.submitCurrentFile', async (uri?: vscode.Uri) => {
        const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
            vscode.window.showWarningMessage('No file open to submit.');
            return;
        }

        const scriptPath = fileUri.fsPath;

        // Get job dependencies if configured
        const dependency = await promptAndGetDependencyString(slurmService);
        if (dependency === null) {
            return; // User cancelled
        }

        let result;
        if (slurmService.isRemoteMode()) {
            result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Submitting job remotely to '${slurmService.getRemoteHost()}'...`,
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Copying script and submitting via sbatch...' });
                return await slurmService.submitJob(scriptPath, undefined, dependency);
            });
        } else {
            result = await slurmService.submitJob(scriptPath, undefined, dependency);
        }

        if (result.success) {
            vscode.window.setStatusBarMessage(`$(check) ${result.message}`, 5000);
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

    // Register Remote SSH commands
    const setupRemoteSSHCmd = vscode.commands.registerCommand('slurmJobs.setupRemoteSSH', () => setupRemoteSSHWizard(slurmService));
    const testRemoteConnCmd = vscode.commands.registerCommand('slurmJobs.testRemoteConnection', () => testRemoteConnectionCommand(slurmService));
    const troubleshootConnCmd = vscode.commands.registerCommand('slurmJobs.troubleshootConnection', () => troubleshootConnectionCommand(slurmService));

    // Add disposables to context
    context.subscriptions.push(treeView);
    context.subscriptions.push(historyTreeView);
    context.subscriptions.push(partitionUsageTreeView);
    context.subscriptions.push(clusterOverviewTreeView);
    context.subscriptions.push(leaderboardTreeView);
    context.subscriptions.push(refreshCommand);
    context.subscriptions.push(refreshHistoryCommand);
    context.subscriptions.push(refreshPartitionUsageCommand);
    context.subscriptions.push(refreshClusterOverviewCommand);
    context.subscriptions.push(refreshLeaderboardCommand);
    context.subscriptions.push(setLeaderboardTopUserCountCommand);
    context.subscriptions.push(openFileCommand);
    context.subscriptions.push(openStdoutCommand);
    context.subscriptions.push(openStderrCommand);
    context.subscriptions.push(searchCommand);
    context.subscriptions.push(clearSearchCommand);
    context.subscriptions.push(searchHistoryCommand);
    context.subscriptions.push(clearSearchHistoryCommand);
    context.subscriptions.push(setHistoryRangeCommand);
    context.subscriptions.push(nextPageCommand);
    context.subscriptions.push(previousPageCommand);
    context.subscriptions.push(toggleAutoRefreshCommand);
    context.subscriptions.push(setAutoRefreshIntervalCommand);
    context.subscriptions.push(configChangeListener);
    context.subscriptions.push(cancelJobCommand);
    context.subscriptions.push(cancelAllJobsCommand);
    context.subscriptions.push(cancelAllPendingJobsCommand);
    context.subscriptions.push(submitJobCommand);
    context.subscriptions.push(submitCurrentFileCommand);
    context.subscriptions.push(editorChangeListener);
    context.subscriptions.push(docChangeListener);
    context.subscriptions.push(hoverProvider);
    context.subscriptions.push(decorationProvider);
    context.subscriptions.push(decorEditorListener);
    context.subscriptions.push(decorDocListener);
    context.subscriptions.push(pinJobCommand);
    context.subscriptions.push(unpinJobCommand);
    context.subscriptions.push(setupRemoteSSHCmd);
    context.subscriptions.push(testRemoteConnCmd);
    context.subscriptions.push(troubleshootConnCmd);

    // Initialize autorefresh based on saved settings
    startAutoRefresh(slurmJobProvider, jobHistoryProvider, checkedJobIds);

    // Show welcome message on first activation
    vscode.window.showInformationMessage('SLURM Cluster Manager activated. View your jobs in the sidebar.');
}

/**
 * Extension deactivation
 * Called when the extension is deactivated
 */
export function deactivate() {
    stopAutoRefresh();
    if (activeSlurmService && activeSlurmService.isRemoteMode()) {
        activeSlurmService.getSshExecutor()?.cleanup().catch(err => {
            console.error('Failed to clean up remote SSH connection:', err);
        });
    }
    console.log('SLURM Cluster Manager deactivated');
}

/**
 * Prompts the user to configure job dependencies and returns a SLURM dependency string.
 * Returns undefined if no dependencies are configured, or null if the user cancelled.
 */
async function promptAndGetDependencyString(slurmService: SlurmService): Promise<string | undefined | null> {
    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    const behavior = config.get<string>('submitDependencyBehavior', 'prompt');

    if (behavior === 'never') {
        return undefined;
    }

    // Step 1: Ask if they want to submit immediately or with dependencies
    const submitMode = await vscode.window.showQuickPick(
        [
            {
                label: '$(play) Submit immediately',
                description: 'Run the script on the cluster without any dependencies',
                value: 'immediate'
            },
            {
                label: '$(link) Submit with dependencies...',
                description: 'Specify one or more jobs that this job must wait for',
                value: 'dependencies'
            }
        ],
        {
            placeHolder: 'Choose submission mode',
            title: 'Submit SLURM Job'
        }
    );

    if (!submitMode) {
        return null; // User cancelled
    }

    if (submitMode.value === 'immediate') {
        return undefined;
    }

    // Step 2: Fetch active jobs to offer as dependency targets
    let activeJobs: SlurmJob[] = [];
    try {
        activeJobs = await slurmService.getJobs();
    } catch (e) {
        console.error('Failed to fetch active jobs for dependency selection:', e);
    }

    let selectedJobIds: string[] = [];

    if (activeJobs.length === 0) {
        // No active jobs, prompt for manual entry directly
        const manualInput = await vscode.window.showInputBox({
            prompt: 'No active jobs found to select. Enter Job ID(s) to depend on (comma-separated):',
            placeHolder: 'e.g. 12345, 12346',
            validateInput: (value) => {
                if (!value.trim()) {
                    return 'Please enter at least one Job ID';
                }
                const ids = value.split(',').map(s => s.trim());
                for (const id of ids) {
                    if (!/^\d+$/.test(id)) {
                        return `Invalid Job ID: "${id}". Must be a number.`;
                    }
                }
                return null;
            }
        });

        if (!manualInput) {
            return null; // User cancelled
        }

        selectedJobIds = manualInput.split(',').map(s => s.trim());
    } else {
        // Show multi-select QuickPick of active jobs + "Enter Custom Job ID(s)..."
        const items = [
            {
                label: '$(edit) Enter Custom Job ID(s)...',
                description: 'Type in Job IDs not listed below',
                jobId: 'custom',
                alwaysShow: true
            },
            ...activeJobs.map(job => ({
                label: `[${job.jobId}] ${job.name}`,
                description: `State: ${getStateDescription(job.state)} · Partition: ${job.partition}`,
                jobId: job.jobId,
                alwaysShow: false
            }))
        ];

        const selections = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select one or more jobs to depend on',
            title: 'Select Job Dependencies',
            canPickMany: true
        });

        if (!selections || selections.length === 0) {
            return null; // User cancelled or selected nothing
        }

        const isCustomSelected = selections.some(item => item.jobId === 'custom');
        const activeSelectedIds = selections
            .filter(item => item.jobId !== 'custom')
            .map(item => item.jobId);

        if (isCustomSelected) {
            const manualInput = await vscode.window.showInputBox({
                prompt: 'Enter custom SLURM Job ID(s) (comma-separated):',
                placeHolder: 'e.g. 12345, 12346',
                validateInput: (value) => {
                    if (!value.trim() && activeSelectedIds.length === 0) {
                        return 'Please enter at least one Job ID';
                    }
                    if (value.trim()) {
                        const ids = value.split(',').map(s => s.trim());
                        for (const id of ids) {
                            if (!/^\d+$/.test(id)) {
                                return `Invalid Job ID: "${id}". Must be a number.`;
                            }
                        }
                    }
                    return null;
                }
            });

            if (manualInput === undefined) {
                return null; // User cancelled the input box
            }

            const customIds = manualInput.trim()
                ? manualInput.split(',').map(s => s.trim()).filter(Boolean)
                : [];
            selectedJobIds = [...activeSelectedIds, ...customIds];
        } else {
            selectedJobIds = activeSelectedIds;
        }
    }

    if (selectedJobIds.length === 0) {
        vscode.window.showWarningMessage('No job dependencies specified.');
        return null;
    }

    // Step 3: Select dependency condition type
    const depTypeSelection = await vscode.window.showQuickPick(
        [
            {
                label: 'afterok (Recommended)',
                description: 'Starts only after the selected jobs successfully complete (exit code 0)',
                value: 'afterok'
            },
            {
                label: 'afterany',
                description: 'Starts after the selected jobs terminate (regardless of success/failure)',
                value: 'afterany'
            },
            {
                label: 'after',
                description: 'Starts after the selected jobs begin running',
                value: 'after'
            },
            {
                label: 'afternotok',
                description: 'Starts only if the selected jobs fail',
                value: 'afternotok'
            }
        ],
        {
            placeHolder: 'Select dependency condition',
            title: 'Choose Dependency Type'
        }
    );

    if (!depTypeSelection) {
        return null; // User cancelled
    }

    const type = depTypeSelection.value;
    return `${type}:${selectedJobIds.join(':')}`;
}

/**
 * Configure Remote SSH Wizard.
 */
async function setupRemoteSSHWizard(slurmService: SlurmService): Promise<void> {
    const configHosts = parseSshConfigHosts();
    const quickPickItems: vscode.QuickPickItem[] = [];

    if (configHosts.length > 0) {
        quickPickItems.push({
            label: 'Parsed from ~/.ssh/config',
            kind: vscode.QuickPickItemKind.Separator
        });
        configHosts.forEach(host => {
            quickPickItems.push({
                label: host,
                description: 'SSH alias from local configuration'
            });
        });
    }

    quickPickItems.push({
        label: 'Actions',
        kind: vscode.QuickPickItemKind.Separator
    });

    quickPickItems.push({
        label: '$(edit) Enter Custom Host Alias...',
        description: 'Type a custom host alias or username@host'
    });

    quickPickItems.push({
        label: '$(play) Switch to Local Mode (Disable SSH)',
        description: 'Clear remote SSH settings and run commands locally'
    });

    const selectedHostItem = await vscode.window.showQuickPick(quickPickItems, {
        title: 'Configure Remote SSH: Select Host (Step 1 of 3)',
        placeHolder: 'Select an SSH host alias or enter a custom one'
    });

    if (!selectedHostItem) {
        return;
    }

    let remoteHost = '';
    if (selectedHostItem.label.includes('Switch to Local Mode')) {
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        await config.update('remoteHost', '', vscode.ConfigurationTarget.Global);
        await config.update('remoteWorkDir', '', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Switched to local SLURM execution mode.');
        return;
    } else if (selectedHostItem.label.includes('Enter Custom Host Alias')) {
        const customHost = await vscode.window.showInputBox({
            title: 'Configure Remote SSH: Enter Custom Host (Step 1 of 3)',
            prompt: 'Enter the SSH host alias (from ~/.ssh/config) or connection string (e.g. user@host)',
            placeHolder: 'e.g., my-cluster',
            validateInput: (value) => {
                if (!value.trim()) {
                    return 'Host cannot be empty';
                }
                return null;
            }
        });
        if (!customHost) {
            return;
        }
        remoteHost = customHost.trim();
    } else {
        remoteHost = selectedHostItem.label;
    }

    const currentConfig = vscode.workspace.getConfiguration('slurmClusterManager');
    const existingWorkDir = currentConfig.get<string>('remoteWorkDir') || '';
    
    const remoteWorkDir = await vscode.window.showInputBox({
        title: 'Configure Remote SSH: Working Directory (Step 2 of 3)',
        prompt: 'Enter directory path on the remote host for temporary files & job logs',
        placeHolder: 'e.g. ~/ or ~/.vscode-slurm',
        value: existingWorkDir || '~/.vscode-slurm',
        validateInput: (value) => {
            if (!value.trim()) {
                return 'Working directory cannot be empty';
            }
            return null;
        }
    });

    if (remoteWorkDir === undefined) {
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Testing connection to remote host '${remoteHost}'...`,
        cancellable: false
    }, async () => {
        const { SshExecutor } = require('./sshExecutor');
        const testExecutor = new SshExecutor(remoteHost);
        try {
            const res = await testExecutor.execute('squeue --version');
            await testExecutor.cleanup();

            if (res.stderr && !res.stdout) {
                throw new Error(`SSH succeeded but SLURM commands failed: ${res.stderr}`);
            }

            const config = vscode.workspace.getConfiguration('slurmClusterManager');
            await config.update('remoteHost', remoteHost, vscode.ConfigurationTarget.Global);
            await config.update('remoteWorkDir', remoteWorkDir, vscode.ConfigurationTarget.Global);

            vscode.window.showInformationMessage(
                `Successfully connected to Remote SLURM Cluster '${remoteHost}'! Settings saved.`
            );
        } catch (err: any) {
            await testExecutor.cleanup();
            const errMsg = err.message || String(err);
            
            const choice = await vscode.window.showErrorMessage(
                `SSH connection to '${remoteHost}' failed: ${errMsg}`,
                'Save Settings Anyway',
                'Edit & Retry'
            );

            if (choice === 'Save Settings Anyway') {
                const config = vscode.workspace.getConfiguration('slurmClusterManager');
                await config.update('remoteHost', remoteHost, vscode.ConfigurationTarget.Global);
                await config.update('remoteWorkDir', remoteWorkDir, vscode.ConfigurationTarget.Global);
            } else if (choice === 'Edit & Retry') {
                setTimeout(() => {
                    vscode.commands.executeCommand('slurmJobs.setupRemoteSSH');
                }, 100);
            }
        }
    });
}

/**
 * Test remote connection command
 */
async function testRemoteConnectionCommand(slurmService: SlurmService): Promise<void> {
    if (!slurmService.isRemoteMode()) {
        const choice = await vscode.window.showInformationMessage(
            'SLURM Cluster Manager is currently in Local Execution mode. Would you like to configure a remote connection?',
            'Configure Remote SSH...'
        );
        if (choice === 'Configure Remote SSH...') {
            vscode.commands.executeCommand('slurmJobs.setupRemoteSSH');
        }
        return;
    }

    const host = slurmService.getRemoteHost();
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Testing remote SSH connection to '${host}'...`,
        cancellable: false
    }, async () => {
        sshConnectionState = 'connecting';
        const { enabled, interval } = getAutoRefreshConfig();
        updateStatusBar(enabled, interval);

        try {
            const available = await slurmService.isAvailable();
            if (available) {
                sshConnectionState = 'online';
                updateStatusBar(enabled, interval);
                vscode.window.showInformationMessage(
                    `SSH connection to '${host}' is ONLINE. SLURM commands are fully responsive.`
                );
            } else {
                throw new Error('SLURM commands (squeue) are not available on remote host.');
            }
        } catch (err: any) {
            sshConnectionState = 'error';
            updateStatusBar(enabled, interval);
            const errMsg = err.message || String(err);
            const choice = await vscode.window.showErrorMessage(
                `Remote connection test failed for '${host}': ${errMsg}`,
                'Troubleshoot Connection',
                'Retry'
            );
            if (choice === 'Troubleshoot Connection') {
                vscode.commands.executeCommand('slurmJobs.troubleshootConnection');
            } else if (choice === 'Retry') {
                vscode.commands.executeCommand('slurmJobs.testRemoteConnection');
            }
        }
    });
}

/**
 * Troubleshoot connection menu command — context-aware, minimal UI.
 *
 * Local mode   → 2 items: "Connect to remote" + mock mode toggle
 * Remote error → 4 items: retry, reconfigure, local, guide
 * Remote ok    → 3 items: status, change host, local
 */
async function troubleshootConnectionCommand(slurmService: SlurmService): Promise<void> {
    const host = slurmService.getRemoteHost();
    const isRemote = slurmService.isRemoteMode();
    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    const mockMode = config.get<boolean>('mockMode', false);

    // ── Local mode: single clear CTA ─────────────────────────────────────────
    if (!isRemote) {
        const localItems: vscode.QuickPickItem[] = [
            {
                label: '$(settings-gear) Connect to a Remote SLURM Cluster...',
                description: 'Set up passwordless SSH to a remote cluster',
                alwaysShow: true
            },
            {
                label: mockMode ? '$(beaker) Disable Mock Mode' : '$(beaker) Enable Mock Mode',
                description: mockMode ? 'Switch back to real SLURM commands' : 'Simulate cluster data without SSH',
                alwaysShow: true
            }
        ];

        const localSelected = await vscode.window.showQuickPick(localItems, {
            title: 'SLURM: Running Locally',
            placeHolder: 'No remote host configured'
        });
        if (!localSelected) { return; }

        if (localSelected.label.includes('Connect to a Remote')) {
            vscode.commands.executeCommand('slurmJobs.setupRemoteSSH');
        } else if (localSelected.label.includes('Mock Mode')) {
            await config.update('mockMode', !mockMode, vscode.ConfigurationTarget.Global);
        }
        return;
    }

    // ── Remote mode: state-aware items ───────────────────────────────────────
    const isError = sshConnectionState === 'error';
    const remoteItems: vscode.QuickPickItem[] = [];

    if (isError) {
        remoteItems.push({
            label: `$(cloud-offline) ${host}`,
            description: 'Connection failed — select a recovery action below',
            alwaysShow: true
        });
        remoteItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        remoteItems.push({
            label: '$(refresh) Retry Connection',
            description: `Re-test SSH access to '${host}'`,
            alwaysShow: true
        });
        remoteItems.push({
            label: '$(settings-gear) Reconfigure SSH Connection...',
            description: 'Change host, working directory, or key settings',
            alwaysShow: true
        });
        remoteItems.push({
            label: '$(debug-disconnect) Switch to Local Mode',
            description: 'Stop using SSH and run SLURM commands locally',
            alwaysShow: true
        });
        remoteItems.push({
            label: '$(question) View Troubleshooting Guide',
            description: 'Tips for key auth, ssh-agent, and firewalls',
            alwaysShow: true
        });
    } else {
        remoteItems.push({
            label: `$(cloud) ${host}`,
            description: sshConnectionState === 'connecting' ? 'Verifying connection...' : 'SSH multiplexed connection active',
            alwaysShow: true
        });
        remoteItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        remoteItems.push({
            label: '$(settings-gear) Change Remote Host...',
            description: 'Configure a different cluster or working directory',
            alwaysShow: true
        });
        remoteItems.push({
            label: '$(debug-disconnect) Switch to Local Mode',
            description: 'Disconnect and run SLURM commands locally instead',
            alwaysShow: true
        });
    }

    const remoteSelected = await vscode.window.showQuickPick(remoteItems, {
        title: `SLURM: Remote Cluster — ${host}`,
        placeHolder: isError ? 'Connection error — choose a recovery action' : 'Manage your remote connection'
    });

    if (!remoteSelected) { return; }

    if (remoteSelected.label.includes('Retry Connection')) {
        vscode.commands.executeCommand('slurmJobs.testRemoteConnection');
    } else if (remoteSelected.label.includes('Reconfigure SSH') || remoteSelected.label.includes('Change Remote Host')) {
        vscode.commands.executeCommand('slurmJobs.setupRemoteSSH');
    } else if (remoteSelected.label.includes('Switch to Local')) {
        await config.update('remoteHost', '', vscode.ConfigurationTarget.Global);
        await config.update('remoteWorkDir', '', vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('Switched to local execution mode.');
    } else if (remoteSelected.label.includes('View Troubleshooting Guide')) {
        showSshTroubleshootingGuide();
    }
}

/**
 * Writes the troubleshooting guide to a markdown file and opens it.
 */
function showSshTroubleshootingGuide(): void {
    const tempDir = path.join(os.tmpdir(), 'vscode-slurm-remote-logs');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    const filePath = path.join(tempDir, 'SSH_Troubleshooting_Guide.md');
    const guideContent = `# SSH Troubleshooting Guide - SLURM Cluster Manager

If you are experiencing issues connecting your local VS Code extension to your remote SLURM cluster over SSH, follow this guide to resolve them.

## 1. Public Key Authentication (Passwordless SSH)
Because this extension executes SSH commands automatically in the background, **it does not support interactive password prompts**.
- You **must** set up SSH key-based authentication with your remote cluster.
- Copy your local public key to the remote cluster's authorized keys list:
  \`\`\`bash
  ssh-copy-id username@remote-cluster-host
  \`\`\`

## 2. Using SSH Agent (Active Keys)
If your private key is protected by a passphrase, you must add it to your local SSH agent so it is accessible to background commands:
- Start the SSH agent (if not running):
  \`\`\`bash
  eval "$(ssh-agent -s)"
  \`\`\`
- Add your private key to the agent:
  \`\`\`bash
  ssh-add ~/.ssh/id_rsa
  \`\`\`

## 3. Multiplexing (ControlMaster Socket)
This extension uses OpenSSH's multiplexing feature for high performance.
- When it runs, it creates a control socket file under your temporary directory:
  \`\${path.join(os.tmpdir(), 'slurm_ssh_<host>.sock')}\`
- If the socket path becomes stale or corrupted, select **Test Remote SSH Connection** or restart VS Code to cleanly rebuild the multiplexed connection.

## 4. SSH Host Aliases (~/.ssh/config)
It is highly recommended to configure an SSH host alias in your local SSH configuration file:
- Run the **Open local ~/.ssh/config** command to edit this file.
- Example entry:
  \`\`\`text
  Host my-slurm-cluster
      HostName slurm.university.edu
      User myusername
      Port 22
      IdentityFile ~/.ssh/id_rsa
  \`\`\`
- Then, set your extension's **Remote Host** setting to \`my-slurm-cluster\`.
`;
    fs.writeFileSync(filePath, guideContent, 'utf8');
    vscode.workspace.openTextDocument(vscode.Uri.file(filePath)).then(doc => {
        vscode.window.showTextDocument(doc, { preview: true });
    });
}
