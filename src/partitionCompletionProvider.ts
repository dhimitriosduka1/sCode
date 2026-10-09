import * as vscode from 'vscode';
import {
    findPartitionCompletionContext,
    formatPartitionLoadDescription,
    formatPartitionLoadDocumentation,
} from './partitionCompletion';
import { formatLeaderboardRefreshLabel } from './leaderboardRefreshTime';
import { PartitionDataStore } from './partitionDataStore';
import { SlurmService } from './slurmService';

/** Answers faster than this skip the loading placeholder, so a warm cache never flickers */
const LOADING_PLACEHOLDER_DELAY_MS = 150;

/** Typing any of these can open the list: after `=`, `,`, a quote, or the space in `-p gpu` */
export const PARTITION_COMPLETION_TRIGGER_CHARACTERS = ['=', ',', ' ', '"', "'"];

/**
 * Suggests partition names wherever a submit script names a partition,
 * least occupied first, with each partition's load beside its name.
 */
export class PartitionCompletionProvider implements vscode.CompletionItemProvider {
    /** Reads the snapshot GPU Partition Usage shows, which refreshes in the background */
    constructor(
        private readonly slurmService: SlurmService,
        private readonly store: PartitionDataStore,
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
        const context = findPartitionCompletionContext(document.lineAt(position.line).text, position.character);
        if (!context || !(await this.slurmService.isAvailable())) {
            return undefined;
        }

        const range = new vscode.Range(position.line, context.replaceStart, position.line, context.replaceEnd);
        // Normally the background refresh has a snapshot ready; only the very
        // first use, before it lands, has to wait on Slurm
        const pending = this.store.getSnapshot();
        const snapshot = await Promise.race([pending, delay(LOADING_PLACEHOLDER_DELAY_MS)]);

        // VS Code shows nothing while an automatically opened list waits on its
        // provider, so a slow first query would look like the feature isn't there.
        // Show a placeholder now and reopen the list once the data arrives.
        if (snapshot === undefined) {
            void pending.then(() => reopenIfStillTyping(document));
            return new vscode.CompletionList([createStatusItem('Loading partitions…', 'querying Slurm', context.prefix, range)], true);
        }

        const { loads, fetchedAt } = snapshot;
        const available = loads.filter(load => !context.alreadyListed.includes(load.partition));
        if (available.length === 0) {
            const description = loads.length === 0 ? 'Slurm returned no partition data' : 'all partitions already listed';
            return [createStatusItem('No partitions to suggest', description, context.prefix, range)];
        }

        return available.map((load, index) => {
            const item = new vscode.CompletionItem(
                { label: load.partition, description: formatPartitionLoadDescription(load) },
                // Distinct icons tell GPU and CPU-only partitions apart
                load.resource === 'GPU' ? vscode.CompletionItemKind.Event : vscode.CompletionItemKind.Value,
            );
            item.range = range;
            // Keeps GPU partitions first, each group least occupied first; VS Code otherwise sorts alphabetically
            item.sortText = String(index).padStart(4, '0');
            // Data can be minutes old between refreshes, so say how old
            item.documentation = new vscode.MarkdownString(
                `${formatPartitionLoadDocumentation(load)}\n\n_${formatLeaderboardRefreshLabel(fetchedAt)}_`,
            );
            return item;
        });
    }
}

/**
 * A row that reports state instead of a partition. Accepting it inserts what
 * was already typed, so it can never change the script.
 */
function createStatusItem(label: string, description: string, typed: string, range: vscode.Range): vscode.CompletionItem {
    const item = new vscode.CompletionItem({ label, description }, vscode.CompletionItemKind.Text);
    item.insertText = typed;
    // Matches whatever was typed, so typing doesn't filter the row away
    item.filterText = typed;
    item.range = range;
    item.sortText = '0000';
    return item;
}

/** Reopen the suggestions with real data, unless the user has moved on from the partition value. */
function reopenIfStillTyping(document: vscode.TextDocument): void {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document !== document) {
        return;
    }

    const cursor = editor.selection.active;
    if (findPartitionCompletionContext(document.lineAt(cursor.line).text, cursor.character)) {
        void vscode.commands.executeCommand('editor.action.triggerSuggest');
    }
}

function delay(ms: number): Promise<undefined> {
    return new Promise(resolve => setTimeout(() => resolve(undefined), ms));
}
