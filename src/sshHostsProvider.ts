import * as vscode from 'vscode';
import { formatSshHostTarget, SshConfigHost } from './sshConfigHosts';

class SshHostItem extends vscode.TreeItem {
    constructor(readonly host: SshConfigHost) {
        super(host.alias, vscode.TreeItemCollapsibleState.None);
        // The tooltip repeats the target for when a narrow sidebar truncates it
        this.description = formatSshHostTarget(host);
        this.tooltip = this.description;
        this.iconPath = new vscode.ThemeIcon('remote');
        this.contextValue = 'sshHost';
    }
}

/** The SSH config's hosts, listed in the status view when Slurm is not on this machine. */
export class SshHostsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private hosts: SshConfigHost[] = [];
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    setHosts(hosts: SshConfigHost[]): void {
        this.hosts = hosts;
        this.changeEmitter.fire();
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    getChildren(): vscode.TreeItem[] {
        return this.hosts.map((host) => new SshHostItem(host));
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}
