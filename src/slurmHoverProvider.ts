import * as vscode from 'vscode';
import { findPartitionNameAt, findPartitionNames, formatPartitionHover } from './partitionCompletion';
import { PARTITION_REFRESH_COMMAND } from './leaderboardRefreshTime';
import { PartitionDataStore } from './partitionDataStore';
import { SlurmService } from './slurmService';

/**
 * Shows a partition's load when hovering its name in a submit script, from
 * the same background snapshot as GPU Partition Usage and autocomplete, so
 * all three agree. Hovering runs no Slurm command of its own.
 */
export class SlurmHoverProvider implements vscode.HoverProvider {
    constructor(
        private readonly slurmService: SlurmService,
        private readonly store: PartitionDataStore,
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Hover | undefined> {
        const partition = findPartitionNameAt(document.lineAt(position.line).text, position.character);
        if (!partition || !(await this.slurmService.isAvailable())) {
            return undefined;
        }

        // VS Code shows its own loading state while the first snapshot is fetched
        const { loads, fetchedAt } = await this.store.getSnapshot();
        if (loads.length === 0) {
            return undefined;
        }

        const markdown = new vscode.MarkdownString(
            formatPartitionHover(partition.name, loads.find(load => load.partition === partition.name), fetchedAt),
            true,
        );
        // Lets the refresh button run, and nothing else
        markdown.isTrusted = { enabledCommands: [PARTITION_REFRESH_COMMAND] };

        return new vscode.Hover(markdown, new vscode.Range(position.line, partition.start, position.line, partition.end));
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

        // Partition names sit in the header or on early srun lines; scanning further isn't worth it per keystroke
        const linesToScan = Math.min(doc.lineCount, 100);
        for (let i = 0; i < linesToScan; i++) {
            for (const { start, end } of findPartitionNames(doc.lineAt(i).text)) {
                decorations.push({ range: new vscode.Range(i, start, i, end) });
            }
        }

        editor.setDecorations(this.decorationType, decorations);
    }

    dispose(): void {
        this.decorationType.dispose();
    }
}
