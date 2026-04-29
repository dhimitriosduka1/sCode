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
import { hasUnresolvedSlurmPathPlaceholders, normalizeOpenableFilePath, SlurmService } from './slurmService';
import { LocalSlurmExecutor, SshSlurmExecutor, validateRemoteFilePath } from './slurmExecutor';
import { createRemoteSlurmUri, RemoteSlurmDocumentProvider, REMOTE_SLURM_SCHEME } from './remoteSlurmDocumentProvider';
import { JobPathCache } from './jobPathCache';
import { SubmitScriptCache } from './submitScriptCache';
import { PinnedJobsCache } from './pinnedJobsCache';
import {
    ConnectionMode,
    formatClusterProfileDescription,
    formatClusterProfileLabel,
    inferClusterNameFromHost,
    LOCAL_CLUSTER_NAME,
    mergeClusterProfiles,
    normalizeClusterProfiles,
    normalizeRemoteLogMaxBytes,
    normalizeSshConnectTimeout,
    resolveActiveClusterProfile,
    SlurmClusterProfile,
    upsertClusterProfile,
    validateClusterName,
    validateSshHost,
} from './clusterProfiles';
import * as fs from 'fs';

// Auto-refresh timer
let autoRefreshTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem;
let connectionStatusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext | undefined;

const STORED_CLUSTER_PROFILES_KEY = 'slurmClusterManager.clusters';
const STORED_ACTIVE_CLUSTER_KEY = 'slurmClusterManager.activeCluster';

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

function getStoredActiveClusterName(): string {
    const storedActiveCluster = extensionContext?.globalState.get<string>(STORED_ACTIVE_CLUSTER_KEY, '') ?? '';
    if (storedActiveCluster) {
        return storedActiveCluster;
    }

    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    return config.get<string>('activeCluster', '');
}

function getClusterProfiles(): SlurmClusterProfile[] {
    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    return mergeClusterProfiles(
        normalizeClusterProfiles(config.get<unknown>('clusters', [])),
        normalizeClusterProfiles(extensionContext?.globalState.get<unknown>(STORED_CLUSTER_PROFILES_KEY, []))
    );
}

function getActiveClusterProfile(): SlurmClusterProfile {
    const config = vscode.workspace.getConfiguration('slurmClusterManager');
    return resolveActiveClusterProfile({
        activeCluster: getStoredActiveClusterName(),
        clusters: getClusterProfiles(),
        connectionMode: config.get<ConnectionMode>('connectionMode', 'local'),
        sshHost: config.get<string>('sshHost', ''),
        sshConnectTimeout: config.get<number>('sshConnectTimeout', 10),
        remoteLogMaxBytes: config.get<number>('remoteLogMaxBytes', 2 * 1024 * 1024),
    });
}

async function saveClusterProfiles(profiles: SlurmClusterProfile[]): Promise<void> {
    await extensionContext?.globalState.update(STORED_CLUSTER_PROFILES_KEY, profiles);
}

async function updateConfigurationIfPossible(section: string, value: unknown): Promise<void> {
    try {
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        await config.update(section, value, vscode.ConfigurationTarget.Global);
    } catch (error) {
        console.warn(`Could not update slurmClusterManager.${section}:`, error);
    }
}

async function saveActiveCluster(profile: SlurmClusterProfile): Promise<void> {
    await extensionContext?.globalState.update(STORED_ACTIVE_CLUSTER_KEY, profile.name);
    await updateConfigurationIfPossible('connectionMode', profile.connectionMode);

    if (profile.connectionMode === 'ssh') {
        await updateConfigurationIfPossible('sshHost', profile.sshHost ?? '');
        await updateConfigurationIfPossible('sshConnectTimeout', normalizeSshConnectTimeout(profile.sshConnectTimeout));
    }
}

function getConnectionMode(): ConnectionMode {
    return getActiveClusterProfile().connectionMode;
}

function getSshHost(): string {
    return getActiveClusterProfile().sshHost?.trim() ?? '';
}

function getSshConnectTimeout(): number {
    const profile = getActiveClusterProfile();
    const fallback = vscode.workspace.getConfiguration('slurmClusterManager').get<number>('sshConnectTimeout', 10);
    return normalizeSshConnectTimeout(profile.sshConnectTimeout ?? fallback);
}

function getRemoteLogMaxBytes(): number {
    const profile = getActiveClusterProfile();
    const fallback = vscode.workspace.getConfiguration('slurmClusterManager').get<number>('remoteLogMaxBytes', 2 * 1024 * 1024);
    return normalizeRemoteLogMaxBytes(profile.remoteLogMaxBytes ?? fallback);
}

function createSlurmExecutorFromConfig(): LocalSlurmExecutor | SshSlurmExecutor {
    const profile = getActiveClusterProfile();
    if (profile.connectionMode === 'ssh') {
        return new SshSlurmExecutor({
            host: profile.sshHost ?? '',
            connectTimeoutSeconds: normalizeSshConnectTimeout(profile.sshConnectTimeout),
        });
    }

    return new LocalSlurmExecutor();
}

function isUnavailableFilePath(filePath: string | undefined): boolean {
    if (!filePath) {
        return true;
    }

    const normalized = filePath.trim().toLowerCase();
    return normalized === 'n/a' || normalized === '(null)' || normalized === 'unknown' || normalized === 'none';
}

async function promptRemoteSubmitPath(initialValue?: string): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
        title: 'Submit Remote SLURM Job',
        prompt: 'Enter the absolute path to a SLURM submit script on the remote server.',
        placeHolder: '/home/user/project/train.sbatch',
        value: initialValue,
        validateInput: (value) => {
            try {
                validateRemoteFilePath(value.trim());
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        },
    });

    return input?.trim();
}

async function promptSshHost(initialValue?: string): Promise<string | undefined> {
    const host = await vscode.window.showInputBox({
        title: 'Connect to Remote SLURM Cluster',
        prompt: 'Enter an OpenSSH host alias or user@host value. Authentication uses your SSH keys or agent.',
        placeHolder: 'cluster-login or user@cluster.example.edu',
        value: initialValue,
        validateInput: (value) => {
            try {
                validateSshHost(value);
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        },
    });

    return host?.trim();
}

async function promptClusterName(defaultName: string, existingProfiles: SlurmClusterProfile[]): Promise<string | undefined> {
    const clusterName = await vscode.window.showInputBox({
        title: 'Name SLURM Cluster',
        prompt: 'Enter a display name for this cluster profile.',
        placeHolder: 'gpu-login',
        value: defaultName,
        validateInput: (value) => {
            try {
                validateClusterName(value);
                const trimmed = value.trim();
                const existing = existingProfiles.find(profile => profile.name.toLowerCase() === trimmed.toLowerCase());
                if (existing && existing.name !== trimmed) {
                    return `A cluster named "${existing.name}" already exists`;
                }
                return null;
            } catch (error) {
                return error instanceof Error ? error.message : String(error);
            }
        },
    });

    return clusterName?.trim();
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
    extensionContext = context;

    // Create the job path cache (persistent storage)
    const jobPathCache = new JobPathCache(context);

    // Create the submit script cache (persistent storage)
    const submitScriptCache = new SubmitScriptCache(context);

    // Create the pinned jobs cache (persistent storage)
    const pinnedJobsCache = new PinnedJobsCache(context);

    // Create shared SlurmService with caches
    const slurmService = new SlurmService(
        jobPathCache,
        submitScriptCache,
        createSlurmExecutorFromConfig(),
        isMockModeEnabled
    );

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

    connectionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    connectionStatusBarItem.command = 'slurmRemote.switchCluster';
    context.subscriptions.push(connectionStatusBarItem);

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

    const remoteDocumentProvider = new RemoteSlurmDocumentProvider(slurmService, getRemoteLogMaxBytes);
    const remoteDocumentRegistration = vscode.workspace.registerTextDocumentContentProvider(
        REMOTE_SLURM_SCHEME,
        remoteDocumentProvider,
    );

    let connectionStatusRequestId = 0;
    async function updateConnectionStatusBar(): Promise<void> {
        const requestId = ++connectionStatusRequestId;
        const profile = getActiveClusterProfile();
        const label = formatClusterProfileLabel(profile);
        connectionStatusBarItem.text = `$(loading~spin) SLURM: ${label}`;
        connectionStatusBarItem.tooltip = 'Checking SLURM connection...';
        connectionStatusBarItem.backgroundColor = undefined;
        connectionStatusBarItem.show();

        const status = await slurmService.getAvailabilityStatus();
        if (requestId !== connectionStatusRequestId) {
            return;
        }

        if (status.available) {
            connectionStatusBarItem.text = `$(server-environment) SLURM: ${label}`;
            connectionStatusBarItem.tooltip = `${status.message}\nClick to switch SLURM cluster.`;
            connectionStatusBarItem.backgroundColor = undefined;
        } else {
            connectionStatusBarItem.text = `$(warning) SLURM: ${label}`;
            connectionStatusBarItem.tooltip = `${status.message}\nClick to switch or configure a SLURM cluster.`;
            connectionStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
    }

    function refreshAllViewsForConnectionChange(): void {
        slurmService.setExecutor(createSlurmExecutorFromConfig());
        checkedJobIds.clear();
        vscode.commands.executeCommand('setContext', 'slurmJobs.hasCheckedJobs', false);
        slurmJobProvider.refresh();
        jobHistoryProvider.refresh();
        partitionUsageProvider.refresh();
        clusterOverviewProvider.refresh();
        leaderboardProvider.refresh();
        void updateConnectionStatusBar();
    }

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

    const testRemoteConnectionCommand = vscode.commands.registerCommand('slurmRemote.testConnection', async () => {
        if (getConnectionMode() === 'ssh' && !getSshHost()) {
            const selection = await vscode.window.showWarningMessage(
                'Set an SSH host before testing the remote SLURM connection.',
                'Configure SSH'
            );
            if (selection === 'Configure SSH') {
                await vscode.commands.executeCommand('slurmRemote.configure', 'ssh' as ConnectionMode);
            }
            return;
        }

        const result = await slurmService.testConnection();
        void updateConnectionStatusBar();
        if (result.success) {
            vscode.window.showInformationMessage(result.message);
        } else {
            const configureLabel = getConnectionMode() === 'local' ? 'Connect with SSH' : 'Edit Connection';
            const selection = await vscode.window.showErrorMessage(
                result.message,
                configureLabel,
                'Open Settings'
            );
            if (selection === configureLabel) {
                await vscode.commands.executeCommand(
                    'slurmRemote.configure',
                    getConnectionMode() === 'local' ? ('ssh' as ConnectionMode) : undefined
                );
            } else if (selection === 'Open Settings') {
                await vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    '@ext:dhimitriosduka.slurm-cluster-manager'
                );
            }
        }
    });

    const switchClusterCommand = vscode.commands.registerCommand('slurmRemote.switchCluster', async () => {
        const currentProfile = getActiveClusterProfile();
        const profiles = getClusterProfiles();
        const clusterOptions = [
            {
                label: currentProfile.connectionMode === 'local' ? '$(check) Local' : 'Local',
                description: 'Run Slurm commands on this machine',
                profile: { name: LOCAL_CLUSTER_NAME, connectionMode: 'local' as ConnectionMode },
            },
            ...profiles.map(profile => ({
                label: `${currentProfile.name === profile.name ? '$(check) ' : ''}${formatClusterProfileLabel(profile)}`,
                description: formatClusterProfileDescription(profile),
                profile,
            })),
            {
                label: '$(add) Add SSH Cluster...',
                description: 'Create a new remote Slurm connection profile',
                profile: undefined,
            },
        ];

        const selected = await vscode.window.showQuickPick(clusterOptions, {
            title: 'Switch SLURM Cluster',
            placeHolder: `Active: ${formatClusterProfileLabel(currentProfile)}`,
        });

        if (!selected) {
            return;
        }

        if (!selected.profile) {
            await vscode.commands.executeCommand('slurmRemote.configure', 'ssh' as ConnectionMode);
            return;
        }

        await saveActiveCluster(selected.profile);
        refreshAllViewsForConnectionChange();
        const selection = await vscode.window.showInformationMessage(
            `Active SLURM cluster: ${formatClusterProfileLabel(selected.profile)}.`,
            'Test Connection'
        );
        if (selection === 'Test Connection') {
            await vscode.commands.executeCommand('slurmRemote.testConnection');
        }
    });

    const configureRemoteCommand = vscode.commands.registerCommand('slurmRemote.configure', async (preferredMode?: ConnectionMode) => {
        const currentProfile = getActiveClusterProfile();
        const modeOptions = [
            { label: 'Local', description: 'Run Slurm commands on this machine', mode: 'local' as ConnectionMode },
            { label: 'SSH Cluster', description: 'Create or update a remote Slurm connection profile', mode: 'ssh' as ConnectionMode },
        ];
        const selectedMode = preferredMode === 'local' || preferredMode === 'ssh'
            ? modeOptions.find(option => option.mode === preferredMode)
            : await vscode.window.showQuickPick(
                modeOptions,
                {
                    title: 'Connect to SLURM Cluster',
                    placeHolder: `Active: ${formatClusterProfileLabel(currentProfile)}`,
                }
            );

        if (!selectedMode) {
            return;
        }

        if (selectedMode.mode === 'ssh') {
            const sshHost = await promptSshHost(getSshHost());
            if (!sshHost) {
                return;
            }

            const existingProfiles = getClusterProfiles();
            const defaultName = currentProfile.connectionMode === 'ssh' && currentProfile.sshHost === sshHost
                ? currentProfile.name
                : inferClusterNameFromHost(sshHost);
            const clusterName = await promptClusterName(defaultName, existingProfiles);
            if (!clusterName) {
                return;
            }

            const profile: SlurmClusterProfile = {
                name: clusterName,
                connectionMode: 'ssh',
                sshHost,
                sshConnectTimeout: getSshConnectTimeout(),
                remoteLogMaxBytes: getRemoteLogMaxBytes(),
            };

            await saveClusterProfiles(upsertClusterProfile(existingProfiles, profile));
            await saveActiveCluster(profile);
        } else {
            await saveActiveCluster({ name: LOCAL_CLUSTER_NAME, connectionMode: 'local' });
        }

        refreshAllViewsForConnectionChange();
        const activeProfile = getActiveClusterProfile();
        const message = `Active SLURM cluster: ${formatClusterProfileLabel(activeProfile)}.`;
        const selection = await vscode.window.showInformationMessage(message, 'Test Connection');
        if (selection === 'Test Connection') {
            await vscode.commands.executeCommand('slurmRemote.testConnection');
        }
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
        if (isUnavailableFilePath(filePath)) {
            vscode.window.showWarningMessage('File path not available');
            return;
        }

        if (hasUnresolvedSlurmPathPlaceholders(filePath) || filePath.includes('PENDING_NODE')) {
            vscode.window.showWarningMessage(
                `Output path is not fully resolved yet: ${filePath}. Refresh after the job starts or finishes.`
            );
            return;
        }

        if (slurmService.isRemoteMode()) {
            try {
                validateRemoteFilePath(filePath);
                const info = await slurmService.getRemoteFileInfo(filePath);
                const maxBytes = getRemoteLogMaxBytes();
                if (!/regular.*file/i.test(info.type)) {
                    vscode.window.showWarningMessage(`Remote path is not a regular file: ${filePath}`);
                    return;
                }
                if (info.size > maxBytes) {
                    vscode.window.showWarningMessage(`Remote file is too large to open (${info.size} bytes, limit ${maxBytes} bytes).`);
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(
                    createRemoteSlurmUri(filePath, slurmService.getConnectionKey())
                );
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showWarningMessage(`Remote file not available: ${errorMessage}`);
            }
            return;
        }

        const normalizedFilePath = normalizeOpenableFilePath(
            filePath,
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        );

        if (!normalizedFilePath) {
            vscode.window.showWarningMessage('File path not available');
            return;
        }

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
            refreshAllViewsForConnectionChange();
        }

        if (e.affectsConfiguration('slurmClusterManager.connectionMode') ||
            e.affectsConfiguration('slurmClusterManager.sshHost') ||
            e.affectsConfiguration('slurmClusterManager.sshConnectTimeout') ||
            e.affectsConfiguration('slurmClusterManager.remoteLogMaxBytes') ||
            e.affectsConfiguration('slurmClusterManager.clusters') ||
            e.affectsConfiguration('slurmClusterManager.activeCluster')) {
            refreshAllViewsForConnectionChange();
        }

        if (e.affectsConfiguration('slurmClusterManager.leaderboardTopUserCount')) {
            leaderboardProvider.rerender();
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
        if (slurmService.isRemoteMode()) {
            const remoteScriptPath = await promptRemoteSubmitPath();
            if (!remoteScriptPath) {
                return;
            }

            const result = await slurmService.submitJob(remoteScriptPath);
            if (result.success) {
                vscode.window.showInformationMessage(result.message);
                slurmJobProvider.refresh();
                jobHistoryProvider.refresh();
            } else {
                vscode.window.showErrorMessage(result.message);
            }
            return;
        }

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

    // Register submit current file command (for CodeLens)
    const submitCurrentFileCommand = vscode.commands.registerCommand('slurmJobs.submitCurrentFile', async (uri?: vscode.Uri) => {
        if (slurmService.isRemoteMode()) {
            const remoteScriptPath = await promptRemoteSubmitPath();
            if (!remoteScriptPath) {
                return;
            }

            const result = await slurmService.submitJob(remoteScriptPath);
            if (result.success) {
                vscode.window.setStatusBarMessage(`$(check) ${result.message}`, 5000);
                slurmJobProvider.refresh();
                jobHistoryProvider.refresh();
            } else {
                vscode.window.showErrorMessage(result.message);
            }
            return;
        }

        const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
            vscode.window.showWarningMessage('No file open to submit.');
            return;
        }

        const scriptPath = fileUri.fsPath;
        const result = await slurmService.submitJob(scriptPath);

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
    context.subscriptions.push(testRemoteConnectionCommand);
    context.subscriptions.push(switchClusterCommand);
    context.subscriptions.push(configureRemoteCommand);
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
    context.subscriptions.push(remoteDocumentRegistration);
    context.subscriptions.push(remoteDocumentProvider);
    context.subscriptions.push(decorationProvider);
    context.subscriptions.push(decorEditorListener);
    context.subscriptions.push(decorDocListener);
    context.subscriptions.push(pinJobCommand);
    context.subscriptions.push(unpinJobCommand);

    // Initialize autorefresh based on saved settings
    startAutoRefresh(slurmJobProvider, jobHistoryProvider, checkedJobIds);
    void updateConnectionStatusBar();

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
