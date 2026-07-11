import * as vscode from 'vscode';
import { MaintenanceWindow } from './slurmService';
import {
    formatMaintenanceWarningLabel,
    formatMaintenanceWarningTooltip,
    getMostRelevantMaintenanceWindow,
} from './maintenanceWarning';

/**
 * Tree item warning about an upcoming or in-progress cluster maintenance
 * window. Shared across every tree view (Active Jobs, GPU Partition Usage,
 * Cluster Overview, ...) so the warning looks and behaves identically
 * everywhere it appears.
 */
export class MaintenanceWarningItem extends vscode.TreeItem {
    constructor(window: MaintenanceWindow, isActive: boolean, now: Date = new Date()) {
        const status = { window, isActive };
        super(formatMaintenanceWarningLabel(status, now), vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(
            isActive ? 'warning' : 'clock',
            new vscode.ThemeColor(isActive ? 'charts.red' : 'charts.orange'),
        );
        this.contextValue = 'maintenanceWarning';
        this.tooltip = new vscode.MarkdownString(formatMaintenanceWarningTooltip(status));
    }
}

/**
 * Builds the maintenance warning tree item for a list of maintenance windows,
 * or returns undefined if none are currently relevant (nothing upcoming/active).
 */
export function createMaintenanceWarningItem(
    windows: MaintenanceWindow[],
    now: Date = new Date(),
): vscode.TreeItem | undefined {
    const status = getMostRelevantMaintenanceWindow(windows, now);
    if (!status) {
        return undefined;
    }

    return new MaintenanceWarningItem(status.window, status.isActive, now);
}
