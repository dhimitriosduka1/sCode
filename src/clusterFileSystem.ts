import * as vscode from 'vscode';
import { ClusterConnection, NotConnectedError } from './clusterConnection';
import { RemoteFileError } from './sshConnection';
import {
    formatLogTruncationNotice,
    hasLogChanged,
    isLogCheckDue,
    LOG_CHECK_INTERVAL_MS,
    LogVersion,
    MAX_REMOTE_LOG_BYTES,
} from './clusterLogs';

/** Files on the connected cluster: `slurm-cluster://<host alias>/<absolute path>`. */
export const CLUSTER_FILE_SCHEME = 'slurm-cluster';

export function clusterFileUri(alias: string, filePath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: CLUSTER_FILE_SCHEME, authority: alias, path: filePath });
}

const READ_ONLY = 'Files on the cluster open read-only.';

/**
 * Serves files on the connected cluster to editors, read-only, over the same
 * SSH connection Slurm commands use: nothing is copied to this machine. Logs
 * larger than MAX_REMOTE_LOG_BYTES show only their end, which is the part that
 * says how a job went, with a line saying so. Logs open in tabs are checked
 * for new output every few seconds and re-read when they change.
 */
export class ClusterFileSystemProvider implements vscode.FileSystemProvider {
    private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changeEmitter.event;

    /** Size and time of each file as last read, by URI. */
    private readonly readVersions = new Map<string, LogVersion>();
    private checkTimer?: NodeJS.Timeout;
    private checking = false;
    private checkRound = 0;
    private disposed = false;

    constructor(private readonly connection: ClusterConnection) {}

    /**
     * Keeps logs open in tabs up to date, as VS Code does for local files: while
     * any is open, they are stat'ed together in one SSH call every few seconds,
     * and each that changed is re-read. Checks pause while the window is in the
     * background, and stop when no log is open.
     */
    watchOpenLogs(): vscode.Disposable {
        const onTabs = vscode.window.tabGroups.onDidChangeTabs(() => {
            this.forgetClosedLogs();
            this.scheduleCheck();
        });
        const onFocus = vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                this.scheduleCheck(0);
            }
        });
        this.scheduleCheck();
        return new vscode.Disposable(() => {
            onTabs.dispose();
            onFocus.dispose();
            this.stopChecks();
        });
    }

    /** Makes an open editor re-read the file, e.g. a log that grew since it opened. */
    refresh(uri: vscode.Uri): void {
        this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    watch(): vscode.Disposable {
        // Open logs are checked by watchOpenLogs instead
        return new vscode.Disposable(() => undefined);
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const stat = await this.call(uri, () => this.connection.statFile(uri.authority, uri.path));
        return {
            type: stat.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File,
            ctime: stat.mtimeMs,
            mtime: stat.mtimeMs,
            // What readFile returns, so the editor never takes a huge log for too large to open
            size: Math.min(stat.size, MAX_REMOTE_LOG_BYTES),
            permissions: vscode.FilePermission.Readonly,
        };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const stat = await this.call(uri, () => this.connection.statFile(uri.authority, uri.path));
        if (stat.type === 'directory') {
            throw vscode.FileSystemError.FileIsADirectory(uri);
        }
        const content = await this.call(uri, () => this.connection.readFileTail(uri.authority, uri.path, MAX_REMOTE_LOG_BYTES));
        this.readVersions.set(uri.toString(), { size: stat.size, mtimeMs: stat.mtimeMs });
        if (stat.size <= MAX_REMOTE_LOG_BYTES) {
            return content;
        }
        return Buffer.concat([Buffer.from(formatLogTruncationNotice(stat.size)), content]);
    }

    readDirectory(): [string, vscode.FileType][] {
        throw vscode.FileSystemError.NoPermissions('Folders on the cluster cannot be listed here.');
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions(READ_ONLY);
    }

    writeFile(): void {
        throw vscode.FileSystemError.NoPermissions(READ_ONLY);
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions(READ_ONLY);
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions(READ_ONLY);
    }

    dispose(): void {
        this.stopChecks();
        this.changeEmitter.dispose();
    }

    /** Cluster files open in tabs, side-by-side and diff views included. */
    private getOpenLogUris(): vscode.Uri[] {
        const uris = new Map<string, vscode.Uri>();
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                const candidates = input instanceof vscode.TabInputText
                    ? [input.uri]
                    : input instanceof vscode.TabInputTextDiff ? [input.original, input.modified] : [];
                for (const uri of candidates) {
                    if (uri.scheme === CLUSTER_FILE_SCHEME) {
                        uris.set(uri.toString(), uri);
                    }
                }
            }
        }
        return [...uris.values()];
    }

    private forgetClosedLogs(): void {
        const open = new Set(this.getOpenLogUris().map((uri) => uri.toString()));
        for (const key of this.readVersions.keys()) {
            if (!open.has(key)) {
                this.readVersions.delete(key);
            }
        }
    }

    /** Queues the next check, unless one is queued or running, or no log is open. */
    private scheduleCheck(delayMs = LOG_CHECK_INTERVAL_MS): void {
        if (this.disposed || this.checking || this.getOpenLogUris().length === 0) {
            return;
        }
        if (this.checkTimer) {
            if (delayMs > 0) {
                return;
            }
            clearTimeout(this.checkTimer);
        }
        this.checkTimer = setTimeout(() => {
            this.checkTimer = undefined;
            void this.checkOpenLogs();
        }, delayMs);
    }

    private stopChecks(): void {
        this.disposed = true;
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
            this.checkTimer = undefined;
        }
    }

    /** Stats the open logs on the connected host and has editors re-read those that changed. */
    private async checkOpenLogs(): Promise<void> {
        const state = this.connection.getState();
        if (!vscode.window.state.focused || state.kind !== 'connected') {
            this.scheduleCheck();
            return;
        }
        this.checking = true;
        try {
            const round = this.checkRound++;
            const alias = state.host.alias.toLowerCase();
            const due = this.getOpenLogUris().filter((uri) =>
                uri.authority.toLowerCase() === alias && isLogCheckDue(this.readVersions.get(uri.toString()), round));
            if (due.length === 0) {
                return;
            }
            const stats = await this.connection.statFiles(state.host.alias, due.map((uri) => uri.path));
            const changed: vscode.FileChangeEvent[] = [];
            due.forEach((uri, index) => {
                const stat = stats[index];
                const key = uri.toString();
                // Gone or unreadable: leave the editor as it is
                if (!stat || stat.type !== 'file' || !hasLogChanged(this.readVersions.get(key), stat)) {
                    return;
                }
                // Until the editor reads it again, so the next round doesn't fire twice
                this.readVersions.set(key, { size: stat.size, mtimeMs: stat.mtimeMs });
                changed.push({ type: vscode.FileChangeType.Changed, uri });
            });
            if (changed.length > 0 && !this.disposed) {
                this.changeEmitter.fire(changed);
            }
        } catch {
            // A dropped connection is noticed by the connection itself; try again next round
        } finally {
            this.checking = false;
            this.scheduleCheck();
        }
    }

    /** Runs a remote read, turning its failures into the errors editors understand. */
    private async call<T>(uri: vscode.Uri, read: () => Promise<T>): Promise<T> {
        try {
            return await read();
        } catch (error) {
            if (error instanceof RemoteFileError) {
                if (error.reason === 'missing') {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
                if (error.reason === 'denied') {
                    throw vscode.FileSystemError.NoPermissions(uri);
                }
            }
            if (error instanceof NotConnectedError) {
                throw vscode.FileSystemError.Unavailable(`Not connected to ${error.alias}. Connect to it from the SLURM Cluster sidebar to open this file.`);
            }
            throw vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
        }
    }
}
