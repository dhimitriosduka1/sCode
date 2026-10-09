import * as vscode from 'vscode';
import {
    findPartitionCompletionContext,
    formatPartitionLoadDescription,
    formatPartitionLoadDocumentation,
    PartitionCompletionContext,
    rankPartitionsForGpuTypes,
} from './partitionCompletion';
import {
    buildGpuTypeSuggestions,
    findGpuTypeCompletionContext,
    formatGpuTypeDescription,
    formatGpuTypeDocumentation,
    GpuTypeCompletionContext,
} from './gpuTypeCompletion';
import { PARTITION_REFRESH_COMMAND, withPartitionDataFreshness } from './leaderboardRefreshTime';
import { PartitionDataStore, PartitionSnapshot } from './partitionDataStore';
import { readLineGpuTypes, readScriptHeader } from './slurmScriptAnalysis';
import { resolveLineOrScript } from './slurmScriptOptions';
import { SlurmService } from './slurmService';

/** Answers faster than this skip the loading placeholder, so a warm cache never flickers */
const LOADING_PLACEHOLDER_DELAY_MS = 150;

/**
 * Typing any of these can open the list: after `=`, `,`, a quote, the space
 * in `-p gpu`, or the `:` in `--gres=gpu:`
 */
export const SLURM_SCRIPT_COMPLETION_TRIGGER_CHARACTERS = ['=', ',', ' ', '"', "'", ':'];

type CompletionTarget =
    | { kind: 'partition'; context: PartitionCompletionContext }
    | { kind: 'gpuType'; context: GpuTypeCompletionContext };

/**
 * Suggests values for submit-script options from the partition snapshot GPU
 * Partition Usage shows, which refreshes in the background:
 * - partition names, GPU partitions first, each group least occupied first
 * - GPU types for `--gres=gpu:` and `--gpus`, most idle first, limited to the
 *   partitions the request will run in
 */
export class SlurmScriptCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private readonly slurmService: SlurmService,
        private readonly store: PartitionDataStore,
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
        const target = findCompletionTarget(document.lineAt(position.line).text, position.character);
        if (!target || !(await this.slurmService.isAvailable())) {
            return undefined;
        }

        const { context } = target;
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
            const loading = target.kind === 'partition' ? 'Loading partitions…' : 'Loading GPU types…';
            return new vscode.CompletionList([createStatusItem(loading, 'querying Slurm', context.prefix, range)], true);
        }

        return target.kind === 'partition'
            ? createPartitionItems(target.context, snapshot, range, document, position.line)
            : createGpuTypeItems(target.context, snapshot, range, document);
    }
}

function findCompletionTarget(line: string, cursor: number): CompletionTarget | undefined {
    const partition = findPartitionCompletionContext(line, cursor);
    if (partition) {
        return { kind: 'partition', context: partition };
    }

    const gpuType = findGpuTypeCompletionContext(line, cursor);
    return gpuType ? { kind: 'gpuType', context: gpuType } : undefined;
}

function createPartitionItems(
    context: PartitionCompletionContext,
    { loads, fetchedAt }: PartitionSnapshot,
    range: vscode.Range,
    document: vscode.TextDocument,
    line: number,
): vscode.CompletionItem[] {
    const available = loads.filter(load => !context.alreadyListed.includes(load.partition));
    if (available.length === 0) {
        const description = loads.length === 0 ? 'Slurm returned no partition data' : 'all partitions already listed';
        return [createStatusItem('No partitions to suggest', description, context.prefix, range)];
    }

    // Partitions with the GPU types the request asks for come first; the rest
    // stay listed, marked, so the partition can always be switched
    const requestedGpuTypes = context.segment
        ? resolveLineOrScript(
            context.segment.kind,
            readLineGpuTypes(document.lineAt(line).text, context.segment),
            readScriptHeader(readLines(document)).gpuTypes,
        )
        : [];

    return rankPartitionsForGpuTypes(available, requestedGpuTypes).map(({ load, missingGpuTypes }, index) => {
        const item = new vscode.CompletionItem(
            { label: load.partition, description: formatPartitionLoadDescription(load, missingGpuTypes) },
            // Distinct icons tell GPU and CPU-only partitions apart
            load.resource === 'GPU' ? vscode.CompletionItemKind.Event : vscode.CompletionItemKind.Value,
        );
        item.range = range;
        // Keeps the ranking (matching GPU types, then GPU partitions, least occupied first); VS Code otherwise sorts alphabetically
        item.sortText = String(index).padStart(4, '0');
        item.documentation = withFreshness(formatPartitionLoadDocumentation(load), fetchedAt);
        return item;
    });
}

function createGpuTypeItems(
    context: GpuTypeCompletionContext,
    { usage, fetchedAt }: PartitionSnapshot,
    range: vscode.Range,
    document: vscode.TextDocument,
): vscode.CompletionItem[] {
    const partitions = resolveLineOrScript(
        context.segment.kind,
        context.linePartitions,
        readScriptHeader(readLines(document)).partitions,
    );
    const suggestions = buildGpuTypeSuggestions(usage.entries, partitions, context.alreadyListed);
    if (suggestions.kind === 'none') {
        return [createStatusItem('No GPU types to suggest', suggestions.reason, context.prefix, range)];
    }

    return suggestions.types.map((availability, index) => {
        const item = new vscode.CompletionItem(
            { label: availability.type, description: formatGpuTypeDescription(availability, suggestions.partitionCount) },
            vscode.CompletionItemKind.Event,
        );
        item.range = range;
        // Keeps the most idle type first; VS Code otherwise sorts alphabetically
        item.sortText = String(index).padStart(4, '0');
        item.documentation = withFreshness(formatGpuTypeDocumentation(availability), fetchedAt);
        return item;
    });
}

/**
 * Data can be minutes old between refreshes, so the details open with how old
 * it is and a link to refresh, the same line the partition hover shows.
 */
function withFreshness(markdown: string, fetchedAt: Date): vscode.MarkdownString {
    const documentation = new vscode.MarkdownString(withPartitionDataFreshness(markdown, fetchedAt), true);
    documentation.isTrusted = { enabledCommands: [PARTITION_REFRESH_COMMAND] };
    return documentation;
}

/** The document's lines, read lazily so scanning a script's header stops at its first command. */
function* readLines(document: vscode.TextDocument): Generator<string> {
    for (let line = 0; line < document.lineCount; line++) {
        yield document.lineAt(line).text;
    }
}

/**
 * A row that reports state instead of a value. Accepting it inserts what
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

/** Reopen the suggestions with real data, unless the user has moved on from the value. */
function reopenIfStillTyping(document: vscode.TextDocument): void {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document !== document) {
        return;
    }

    const cursor = editor.selection.active;
    if (findCompletionTarget(document.lineAt(cursor.line).text, cursor.character)) {
        void vscode.commands.executeCommand('editor.action.triggerSuggest');
    }
}

function delay(ms: number): Promise<undefined> {
    return new Promise(resolve => setTimeout(() => resolve(undefined), ms));
}
