import * as vscode from 'vscode';
import { describeUnavailable, SlurmUnavailable } from './slurmAvailability';

/** Connecting over SSH relies on OpenSSH connection sharing, which Windows' OpenSSH lacks */
export const CAN_CONNECT_OVER_SSH = process.platform !== 'win32';

/**
 * The row a view shows in place of its content when Slurm can't be reached,
 * which offers to connect when that would help.
 * @param missingLabel what the view says when Slurm isn't on this machine
 */
export function createUnavailableItem(availability: SlurmUnavailable, missingLabel: string): vscode.TreeItem {
    const message = describeUnavailable(availability, missingLabel, CAN_CONNECT_OVER_SSH);
    const item = new vscode.TreeItem(message.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(message.icon);
    item.description = message.description;
    item.tooltip = message.tooltip;
    item.command = message.command;
    return item;
}
