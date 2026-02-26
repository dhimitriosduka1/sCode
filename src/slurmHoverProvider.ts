import * as vscode from 'vscode';
import { SlurmService } from './slurmService';

/**
 * HoverProvider that shows real-time partition stats when hovering over
 * partition names in SLURM submit scripts (#SBATCH --partition or -p).
 */
export class SlurmHoverProvider implements vscode.HoverProvider {
    private slurmService: SlurmService;

    // Brief cache to avoid hammering SLURM on repeated hovers
    private cache = new Map<string, { data: any; timestamp: number }>();
    private readonly CACHE_TTL = 30_000; // 30 seconds

    constructor(slurmService: SlurmService) {
        this.slurmService = slurmService;
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Hover | null> {
        const line = document.lineAt(position.line).text;

        // Match #SBATCH --partition=<name> or #SBATCH -p <name>
        const partitionMatch = line.match(/#SBATCH\s+(?:--partition[=\s]|-p\s+)(\S+)/);
        if (!partitionMatch) {
            return null;
        }

        const partitionName = partitionMatch[1];

        // Check if hover position is actually over the partition name
        const nameStart = line.indexOf(partitionName, line.indexOf('#SBATCH'));
        const nameEnd = nameStart + partitionName.length;
        if (position.character < nameStart || position.character > nameEnd) {
            return null;
        }

        // Check cache
        const cached = this.cache.get(partitionName);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
            return this.buildHover(partitionName, cached.data, position);
        }

        // Fetch stats
        const stats = await this.slurmService.getPartitionStats(partitionName);
        if (!stats) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**Partition: \`${partitionName}\`**\n\n`);
            md.appendMarkdown(`_Could not fetch partition stats_`);
            return new vscode.Hover(md, new vscode.Range(position.line, nameStart, position.line, nameEnd));
        }

        // Cache the result
        this.cache.set(partitionName, { data: stats, timestamp: Date.now() });

        return this.buildHover(partitionName, stats, position, nameStart, nameEnd);
    }

    private buildHover(
        partitionName: string,
        stats: any,
        position: vscode.Position,
        nameStart?: number,
        nameEnd?: number,
    ): vscode.Hover {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        // Header
        md.appendMarkdown(`**📊 Partition: \`${partitionName}\`**\n\n`);

        // GPU usage bar
        const gpuPercent = stats.totalGpus > 0
            ? Math.round((stats.allocatedGpus / stats.totalGpus) * 100)
            : 0;
        const barWidth = 20;
        const filled = Math.round((gpuPercent / 100) * barWidth);
        const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

        md.appendMarkdown(`GPU Usage: \`${bar}\` ${gpuPercent}%\n\n`);

        // Stats table
        md.appendMarkdown(`|Metric|Value|\n`);
        md.appendMarkdown(`|:--|:--|\n`);
        md.appendMarkdown(`| Total GPUs | ${stats.totalGpus} |\n`);
        md.appendMarkdown(`| Allocated | ${stats.allocatedGpus} |\n`);
        md.appendMarkdown(`| Idle | ${stats.idleGpus} |\n`);
        md.appendMarkdown(`| Running Jobs | ${stats.runningJobs} |\n`);
        md.appendMarkdown(`| Pending Jobs | ${stats.pendingJobs} |\n`);
        md.appendMarkdown(`| Nodes (up/total) | ${stats.nodeStates} |\n`);

        const range = nameStart !== undefined && nameEnd !== undefined
            ? new vscode.Range(position.line, nameStart, position.line, nameEnd)
            : undefined;

        return new vscode.Hover(md, range);
    }
}

/**
 * Applies underline decorations to hoverable partition names in SLURM scripts
 * so users know they can hover for stats.
 */
export class SlurmDecorationProvider {
    private decorationType: vscode.TextEditorDecorationType;

    constructor() {
        this.decorationType = vscode.window.createTextEditorDecorationType({
            textDecoration: 'underline dotted',
            cursor: 'pointer',
        });
    }

    updateDecorations(editor: vscode.TextEditor | undefined): void {
        if (!editor) { return; }

        const doc = editor.document;
        const decorations: vscode.DecorationOptions[] = [];

        // Scan first 100 lines for #SBATCH partition directives
        const linesToScan = Math.min(doc.lineCount, 100);
        for (let i = 0; i < linesToScan; i++) {
            const lineText = doc.lineAt(i).text;
            const match = lineText.match(/#SBATCH\s+(?:--partition[=\s]|-p\s+)(\S+)/);
            if (match) {
                const name = match[1];
                const start = lineText.indexOf(name, lineText.indexOf('#SBATCH'));
                const end = start + name.length;
                decorations.push({
                    range: new vscode.Range(i, start, i, end),
                    hoverMessage: 'Hover for partition stats',
                });
            }
        }

        editor.setDecorations(this.decorationType, decorations);
    }

    dispose(): void {
        this.decorationType.dispose();
    }
}
