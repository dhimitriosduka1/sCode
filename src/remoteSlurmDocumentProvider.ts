import * as vscode from 'vscode';
import { SlurmService } from './slurmService';
import {
    createRemoteSlurmQuery,
    getRemoteSlurmConnectionMismatch,
    parseRemoteSlurmConnectionKey,
    REMOTE_SLURM_SCHEME,
} from './remoteSlurmUri';

export { REMOTE_SLURM_SCHEME };

export function createRemoteSlurmUri(remotePath: string, connectionKey?: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: REMOTE_SLURM_SCHEME,
        path: remotePath,
        query: createRemoteSlurmQuery(connectionKey),
    });
}

export class RemoteSlurmDocumentProvider implements vscode.TextDocumentContentProvider {
    private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    constructor(
        private readonly slurmService: SlurmService,
        private readonly maxBytesProvider: () => number,
    ) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const mismatch = getRemoteSlurmConnectionMismatch(
            parseRemoteSlurmConnectionKey(uri.query),
            this.slurmService.getConnectionKey(),
        );
        if (mismatch) {
            throw new Error(mismatch);
        }

        return this.slurmService.readRemoteFile(uri.path, this.maxBytesProvider());
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}
