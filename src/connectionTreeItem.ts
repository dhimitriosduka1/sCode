import * as vscode from 'vscode';
import { SlurmAvailabilityStatus } from './slurmService';
import { formatTooltipMarkdown } from './tooltipMarkdown';

export class SlurmConnectionSetupItem extends vscode.TreeItem {
    constructor(status: SlurmAvailabilityStatus) {
        const isLocal = status.mode === 'local';
        super(
            isLocal ? 'Connect to a remote Slurm cluster' : 'Fix Slurm connection',
            vscode.TreeItemCollapsibleState.None
        );

        this.description = isLocal ? 'Local Slurm CLI not found' : 'Connection unavailable';
        this.iconPath = new vscode.ThemeIcon(isLocal ? 'plug' : 'warning');
        this.contextValue = 'slurmConnectionSetup';
        this.command = {
            command: 'slurmRemote.configure',
            title: 'Connect to SLURM Cluster',
            arguments: [isLocal ? 'ssh' : undefined],
        };
        this.tooltip = new vscode.MarkdownString(formatTooltipMarkdown({
            title: 'SLURM connection',
            summary: status.message,
            note: isLocal
                ? 'Click to configure SSH access to a remote Slurm login node.'
                : 'Click to update the connection mode or SSH host.',
        }));
    }
}
