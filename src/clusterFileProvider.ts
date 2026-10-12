import * as vscode from 'vscode';
import { CLUSTER_FILE_MAX_BYTES, ClusterFileError, readClusterFile, resolveClusterPath } from './clusterFiles';
import { CONNECT_COMMAND } from './slurmAvailability';
import { SlurmCommandRunner, SlurmNotConnectedError } from './slurmCommandRunner';

export const CLUSTER_FILE_SCHEME = 'slurm-cluster';

const TRUNCATED_NOTE = `[Showing the last ${CLUSTER_FILE_MAX_BYTES / (1024 * 1024)} MB of this file. The rest is on the cluster.]`;

export interface ClusterFileOpenOptions {
    viewColumn?: vscode.ViewColumn;
    preserveFocus?: boolean;
    preview?: boolean;
}

/**
 * Shows files from the cluster (logs and submit scripts) as read-only
 * documents, for when Slurm commands run there over SSH. Opening a file
 * again reads it again, which is how a growing log is brought up to date.
 */
export class ClusterFileProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changeEmitter.event;
    /** The latest read of each file, by document URI */
    private readonly contents = new Map<string, string>();
    private readonly disposables: vscode.Disposable[];

    constructor(
        private readonly run: SlurmCommandRunner,
        private readonly getHost: () => string | undefined,
        private readonly getHome: () => Promise<string | undefined>,
    ) {
        this.disposables = [
            this.changeEmitter,
            vscode.workspace.registerTextDocumentContentProvider(CLUSTER_FILE_SCHEME, this),
            vscode.workspace.onDidCloseTextDocument(document => this.contents.delete(document.uri.toString())),
        ];
    }

    /** Opens a file from the cluster, explaining in a message when it can't; returns whether it opened */
    async open(filePath: string, options: ClusterFileOpenOptions = {}): Promise<boolean> {
        const host = this.getHost();
        if (!host) {
            return false;
        }

        try {
            const clusterPath = resolveClusterPath(filePath, await this.getHome());
            const uri = vscode.Uri.from({ scheme: CLUSTER_FILE_SCHEME, authority: host, path: clusterPath });
            await this.load(uri);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, options);
            return true;
        } catch (error) {
            this.explain(error, host, filePath);
            return false;
        }
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        // A document restored from an earlier session hasn't been read yet
        if (!this.contents.has(uri.toString())) {
            try {
                await this.load(uri);
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                return `Couldn't read ${uri.path} from ${uri.authority}: ${reason}`;
            }
        }
        return this.contents.get(uri.toString()) ?? '';
    }

    dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
    }

    private async load(uri: vscode.Uri): Promise<void> {
        // A document from another host can't be read over this connection
        if (uri.authority !== this.getHost()) {
            throw new SlurmNotConnectedError(uri.authority);
        }

        const { text, truncated } = await readClusterFile(this.run, uri.path);
        const key = uri.toString();
        this.contents.set(key, truncated ? `${TRUNCATED_NOTE}\n${text}` : text);

        // VS Code keeps showing what it read first until told the content changed
        if (vscode.workspace.textDocuments.some(document => document.uri.toString() === key)) {
            this.changeEmitter.fire(uri);
        }
    }

    private explain(error: unknown, host: string, filePath: string): void {
        if (error instanceof SlurmNotConnectedError) {
            void vscode.window.showWarningMessage(`Not connected to ${error.host}.`, 'Connect').then(choice => {
                if (choice) {
                    void vscode.commands.executeCommand(CONNECT_COMMAND);
                }
            });
            return;
        }

        if (error instanceof ClusterFileError) {
            switch (error.problem) {
                case 'unresolved':
                    vscode.window.showWarningMessage(error.message);
                    return;
                case 'not-found':
                    vscode.window.showWarningMessage(
                        `File not found on ${host}: ${error.filePath}. The file may not exist yet if the job hasn't started.`
                    );
                    return;
                case 'directory':
                    vscode.window.showWarningMessage(`Output path is a directory, not a file: ${error.filePath}`);
                    return;
                case 'unreadable':
                    vscode.window.showErrorMessage(`Permission denied reading ${error.filePath} on ${host}`);
                    return;
            }
        }

        const reason = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to open file: ${filePath}\n${reason}`);
        console.error('Error opening cluster file:', error);
    }
}
