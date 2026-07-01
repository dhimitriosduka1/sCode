import * as vscode from 'vscode';
import { SSHSession } from './sshSession';

/**
 * TextDocumentContentProvider to read file contents over SSH.
 * Registered with the 'slurm-ssh' URI scheme.
 */
export class SSHFileProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    public static readonly scheme = 'slurm-ssh';
    
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private cache = new Map<string, { content: string; timestamp: number }>();
    private readonly cacheTTL = 30000; // 30 seconds cache TTL

    constructor(private getSession: () => SSHSession | undefined) {}

    /**
     * Creates a slurm-ssh URI for a remote absolute file path
     */
    public static createUri(remotePath: string): vscode.Uri {
        // Ensure path starts with a forward slash
        const formattedPath = remotePath.startsWith('/') ? remotePath : '/' + remotePath;
        return vscode.Uri.parse(`${SSHFileProvider.scheme}://${formattedPath}`);
    }

    /**
     * Resolves and fetches the file contents from the remote cluster
     */
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const cacheKey = uri.toString();
        const cached = this.cache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp < this.cacheTTL)) {
            return cached.content;
        }

        const session = this.getSession();
        if (!session || !session.isConnected()) {
            return 'Error: No active SSH connection to the SLURM cluster.';
        }

        const remotePath = uri.path;

        try {
            // Read remote file via `cat`
            // Escape file path for shell execution
            const result = await session.execute(`cat "${remotePath.replace(/"/g, '\\"')}"`);
            
            if (result.exitCode !== 0) {
                return `Error: Failed to read file '${remotePath}' on remote cluster.\nExit code: ${result.exitCode}\n${result.stdout}`;
            }

            const content = result.stdout;
            this.cache.set(cacheKey, {
                content,
                timestamp: Date.now()
            });

            return content;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Error reading remote file: ${msg}`;
        }
    }

    /**
     * Clears the cache for a specific file URI and triggers a refresh event in the editor
     */
    public refresh(uri: vscode.Uri): void {
        this.cache.delete(uri.toString());
        this._onDidChange.fire(uri);
    }

    dispose(): void {
        this.cache.clear();
        this._onDidChange.dispose();
    }
}
