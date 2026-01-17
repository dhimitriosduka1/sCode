import * as vscode from 'vscode';
import { SlurmJobProvider } from './slurmJobProvider';

/**
 * Extension activation
 * Called when the extension is activated (e.g., when the SLURM view is opened)
 */
export function activate(context: vscode.ExtensionContext) {
    console.log('SLURM Cluster Manager is now active');

    // Create the job provider
    const slurmJobProvider = new SlurmJobProvider();

    // Register the TreeView
    const treeView = vscode.window.createTreeView('slurmJobs', {
        treeDataProvider: slurmJobProvider,
        showCollapseAll: false,
    });

    // Register the refresh command
    const refreshCommand = vscode.commands.registerCommand('slurmJobs.refresh', () => {
        slurmJobProvider.refresh();
    });

    // Add disposables to context
    context.subscriptions.push(treeView);
    context.subscriptions.push(refreshCommand);

    // Show welcome message on first activation
    vscode.window.showInformationMessage('SLURM Cluster Manager activated. View your jobs in the sidebar.');
}

/**
 * Extension deactivation
 * Called when the extension is deactivated
 */
export function deactivate() {
    console.log('SLURM Cluster Manager deactivated');
}
