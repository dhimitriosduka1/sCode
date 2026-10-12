import * as vscode from 'vscode';
import { mapToClusterFolder, validateClusterFolder } from './clusterFiles';

const STATE_KEY = 'clusterSubmitFolders';

/**
 * Where on the cluster this workspace's scripts are submitted from, when
 * Slurm commands run there over SSH: the workspace's copy on the cluster,
 * chosen once per host and remembered for this workspace.
 */
export class ClusterSubmitFolders {
    constructor(
        private readonly state: vscode.Memento,
        private readonly getHome: () => Promise<string | undefined>,
    ) {}

    /**
     * The folder on the cluster to submit a local script from, asking for the
     * workspace's copy the first time. Undefined when the user cancels.
     */
    async folderFor(host: string, scriptPath: string): Promise<string | undefined> {
        const root = this.getRoot(host) ?? await this.choose(host);
        if (!root) {
            return undefined;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(scriptPath));
        const folder = mapToClusterFolder(root, await this.getHome(), workspaceFolder?.uri.fsPath, scriptPath);
        if (!folder) {
            vscode.window.showErrorMessage(`Couldn't find your home directory on ${host} to resolve ${root}. Set the folder as an absolute path.`);
        }
        return folder;
    }

    /** Asks for the workspace's copy on the cluster and remembers it; undefined when cancelled */
    async choose(host: string): Promise<string | undefined> {
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
        const folder = (await vscode.window.showInputBox({
            title: `Submit from which folder on ${host}?`,
            prompt: 'This workspace\'s copy on the cluster. Each script is submitted from the matching folder there, so its relative paths resolve as they do here.',
            value: this.getRoot(host) ?? (workspaceName ? `~/${workspaceName}` : '~'),
            ignoreFocusOut: true,
            validateInput: value => validateClusterFolder(value.trim()),
        }))?.trim();

        if (folder) {
            await this.state.update(STATE_KEY, { ...this.getAll(), [host]: folder });
        }
        return folder;
    }

    private getRoot(host: string): string | undefined {
        return this.getAll()[host];
    }

    private getAll(): Record<string, string> {
        return this.state.get<Record<string, string>>(STATE_KEY) ?? {};
    }
}
