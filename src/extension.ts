import * as vscode from 'vscode';
import { SlurmJobProvider } from './slurmJobProvider';
import * as fs from 'fs';
import * as path from 'path';

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
        showCollapseAll: true,
    });

    // Register the refresh command
    const refreshCommand = vscode.commands.registerCommand('slurmJobs.refresh', () => {
        slurmJobProvider.refresh();
    });

    // Register command to open output files
    const openFileCommand = vscode.commands.registerCommand('slurmJobs.openFile', async (filePath: string) => {
        if (!filePath || filePath === 'N/A') {
            vscode.window.showWarningMessage('File path not available');
            return;
        }

        try {
            // Check if file exists
            if (!fs.existsSync(filePath)) {
                // Try to find the file with common variations
                const dir = path.dirname(filePath);
                const basename = path.basename(filePath);

                // For pending jobs, the file might not exist yet
                vscode.window.showWarningMessage(`File not found: ${filePath}. The file may not exist yet if the job hasn't started.`);
                return;
            }

            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { preview: true });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to open file: ${filePath}\n${errorMessage}`);
            console.error('Error opening file:', error);
        }
    });

    // Register command to open stdout file
    const openStdoutCommand = vscode.commands.registerCommand('slurmJobs.openStdout', async (item: any) => {
        if (item?.job?.stdoutPath) {
            await vscode.commands.executeCommand('slurmJobs.openFile', item.job.stdoutPath);
        }
    });

    // Register command to open stderr file
    const openStderrCommand = vscode.commands.registerCommand('slurmJobs.openStderr', async (item: any) => {
        if (item?.job?.stderrPath) {
            await vscode.commands.executeCommand('slurmJobs.openFile', item.job.stderrPath);
        }
    });

    // Register search command
    const searchCommand = vscode.commands.registerCommand('slurmJobs.search', async () => {
        const currentFilter = slurmJobProvider.getSearchFilter();
        const searchTerm = await vscode.window.showInputBox({
            prompt: 'Search jobs by name or Job ID',
            placeHolder: 'Enter search term...',
            value: currentFilter,
        });

        if (searchTerm !== undefined) {
            if (searchTerm === '') {
                slurmJobProvider.clearSearchFilter();
                vscode.window.showInformationMessage('Search filter cleared');
            } else {
                slurmJobProvider.setSearchFilter(searchTerm);
                vscode.window.showInformationMessage(`Filtering jobs: "${searchTerm}"`);
            }
        }
    });

    // Register clear search command
    const clearSearchCommand = vscode.commands.registerCommand('slurmJobs.clearSearch', () => {
        slurmJobProvider.clearSearchFilter();
        vscode.window.showInformationMessage('Search filter cleared');
    });

    // Add disposables to context
    context.subscriptions.push(treeView);
    context.subscriptions.push(refreshCommand);
    context.subscriptions.push(openFileCommand);
    context.subscriptions.push(openStdoutCommand);
    context.subscriptions.push(openStderrCommand);
    context.subscriptions.push(searchCommand);
    context.subscriptions.push(clearSearchCommand);

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
