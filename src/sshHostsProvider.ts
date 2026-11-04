import * as vscode from 'vscode';
import { SshConfigHost } from './sshConfigHosts';
import {
    formatSshHostRowDescription,
    formatSshHostTooltipMarkdown,
    groupSshHostsBySite,
    OTHER_SSH_HOST_GROUP_LABEL,
    SshHostGroup,
} from './sshHostGroups';

class SshHostGroupItem extends vscode.TreeItem {
    constructor(readonly group: SshHostGroup) {
        super(group.site ?? OTHER_SSH_HOST_GROUP_LABEL, vscode.TreeItemCollapsibleState.Expanded);
        // A stable id lets VS Code keep a group collapsed across refreshes
        this.id = `sshHostGroup:${group.site ?? ''}`;
        this.description = String(group.hosts.length);
        this.iconPath = new vscode.ThemeIcon('globe');
        this.contextValue = 'sshHostGroup';
    }
}

class SshHostItem extends vscode.TreeItem {
    constructor(readonly host: SshConfigHost) {
        super(host.alias, vscode.TreeItemCollapsibleState.None);
        this.id = `sshHost:${host.alias}`;
        this.description = formatSshHostRowDescription(host);
        this.tooltip = new vscode.MarkdownString(formatSshHostTooltipMarkdown(host));
        this.iconPath = new vscode.ThemeIcon('server');
        this.contextValue = 'sshHost';
    }
}

/** The SSH config's hosts by site, listed in the status view when Slurm is not on this machine. */
export class SshHostsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private groups: SshHostGroup[] = [];
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    setHosts(hosts: SshConfigHost[]): void {
        this.groups = groupSshHostsBySite(hosts);
        this.changeEmitter.fire();
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
        return item;
    }

    getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
        if (element instanceof SshHostGroupItem) {
            return element.group.hosts.map((host) => new SshHostItem(host));
        }

        return element ? [] : this.groups.map((group) => new SshHostGroupItem(group));
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}
