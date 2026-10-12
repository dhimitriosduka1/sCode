import * as fs from 'fs';
import * as vscode from 'vscode';
import { SlurmAvailability } from './slurmAvailability';
import { getUserSshConfigPath, readSshConfigHosts, SshConfigHost } from './sshConfigHosts';
import { validateSshHost } from './sshConnection';
import { formatTooltipMarkdown } from './tooltipMarkdown';

export const CONNECT_TO_HOST_COMMAND = 'slurmClusterManager.connectToHost';

type SshTargetState = 'idle' | 'connecting' | 'not-connected' | 'no-slurm';

export class SshTargetItem extends vscode.TreeItem {
    constructor(readonly host: SshConfigHost, state: SshTargetState) {
        super(host.alias, vscode.TreeItemCollapsibleState.None);

        const address = host.hostName ? `${host.user ? `${host.user}@` : ''}${host.hostName}` : undefined;
        const status = {
            'idle': undefined,
            'connecting': 'Connecting…',
            'not-connected': 'Last used',
            'no-slurm': 'SLURM not found',
        }[state];

        this.description = [status, address].filter(Boolean).join(' · ');
        this.iconPath = new vscode.ThemeIcon({
            'idle': 'remote',
            'connecting': 'loading~spin',
            'not-connected': 'remote',
            'no-slurm': 'warning',
        }[state]);
        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title: host.alias,
            summary: state === 'no-slurm' ? 'squeue didn\'t run here. Is it a login node of your cluster?' : 'SSH host from your SSH config',
            details: address ? [{ label: 'Address', value: `\`${address}\`` }] : [],
            note: 'Click to log in. Slurm commands then run on this host.',
        }));
        this.contextValue = 'sshTarget';
        this.command = { command: CONNECT_TO_HOST_COMMAND, title: 'Connect', arguments: [host.alias] };
    }
}

/**
 * Lists the hosts in ~/.ssh/config when Slurm isn't available on this
 * machine, as Remote Explorer lists SSH targets, so connecting to the
 * cluster is one click.
 */
export class SshTargetsProvider implements vscode.TreeDataProvider<SshTargetItem> {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private view: vscode.TreeView<SshTargetItem> | undefined;
    private configuredHost: string | undefined;
    private availability: SlurmAvailability | undefined;
    private connectingTo: string | undefined;

    setView(view: vscode.TreeView<SshTargetItem>): void {
        this.view = view;
    }

    /** Where commands go now and whether Slurm answered there, which decides how hosts are marked */
    setStatus(configuredHost: string | undefined, availability: SlurmAvailability): void {
        this.configuredHost = configuredHost;
        this.availability = availability;
        this.changeEmitter.fire();
    }

    setConnecting(host: string | undefined): void {
        this.connectingTo = host;
        this.changeEmitter.fire();
    }

    /** Re-reads the SSH config */
    refresh(): void {
        this.changeEmitter.fire();
    }

    getTreeItem(element: SshTargetItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SshTargetItem): SshTargetItem[] {
        if (element) {
            return [];
        }

        // Only names this extension will pass to ssh
        const hosts = readSshConfigHosts().filter(host => validateSshHost(host.alias) === undefined);
        // A host typed in rather than picked from the config is still offered
        if (this.configuredHost && !hosts.some(host => host.alias === this.configuredHost)) {
            hosts.unshift({ alias: this.configuredHost });
        }

        if (this.view) {
            // With no hosts, the view's welcome content explains instead
            this.view.message = hosts.length > 0 ? this.describeSituation() : undefined;
        }

        return hosts.map(host => new SshTargetItem(host, this.stateOf(host.alias)));
    }

    private stateOf(alias: string): SshTargetState {
        if (alias === this.connectingTo) {
            return 'connecting';
        }
        if (alias !== this.configuredHost || !this.availability || this.availability.available) {
            return 'idle';
        }
        return this.availability.reason === 'missing' ? 'no-slurm' : 'not-connected';
    }

    private describeSituation(): string {
        const availability = this.availability;
        if (availability && !availability.available && availability.host) {
            return availability.reason === 'missing'
                ? `SLURM wasn't found on ${availability.host}. Choose your cluster's login node:`
                : `Not connected to ${availability.host}. Log in again, or choose another host:`;
        }
        return 'SLURM isn\'t available on this machine. Choose your cluster\'s login node to run it there over SSH:';
    }
}

/** Opens ~/.ssh/config, or a new file to save there when there is none yet */
export async function openSshConfigFile(): Promise<void> {
    const configPath = getUserSshConfigPath();
    const uri = vscode.Uri.file(configPath);
    const document = await vscode.workspace.openTextDocument(fs.existsSync(configPath) ? uri : uri.with({ scheme: 'untitled' }));
    await vscode.window.showTextDocument(document);
}
