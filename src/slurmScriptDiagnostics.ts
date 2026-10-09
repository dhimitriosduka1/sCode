import * as vscode from 'vscode';
import { PartitionDataStore } from './partitionDataStore';
import { analyzeScript, findGpuTypeProblems } from './slurmScriptAnalysis';

/** Long enough not to re-check on every keystroke, short enough to feel live */
const RECHECK_DELAY_MS = 300;

/**
 * Underlines GPU types a submit script requests in partitions that don't have
 * them, which Slurm rejects at submission. Checked against the background
 * partition snapshot, so a script is re-checked whenever that refreshes.
 *
 * Warnings rather than errors: the snapshot can be minutes old, and a cluster
 * that changed in the meantime shouldn't make a valid script look broken.
 */
export class SlurmScriptDiagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('slurm');
    private readonly pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly disposables: vscode.Disposable[];

    constructor(
        private readonly store: PartitionDataStore,
        private readonly selector: vscode.DocumentSelector,
    ) {
        const unsubscribe = store.onDidChange(() => this.checkOpenDocuments());
        this.disposables = [
            this.collection,
            { dispose: unsubscribe },
            vscode.workspace.onDidOpenTextDocument(document => this.check(document)),
            vscode.workspace.onDidChangeTextDocument(event => this.scheduleCheck(event.document)),
            vscode.workspace.onDidCloseTextDocument(document => this.forget(document)),
        ];
        this.checkOpenDocuments();
    }

    dispose(): void {
        this.pendingChecks.forEach(timer => clearTimeout(timer));
        this.disposables.forEach(disposable => disposable.dispose());
    }

    private checkOpenDocuments(): void {
        vscode.workspace.textDocuments.forEach(document => this.check(document));
    }

    private scheduleCheck(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        clearTimeout(this.pendingChecks.get(key));
        this.pendingChecks.set(key, setTimeout(() => {
            this.pendingChecks.delete(key);
            this.check(document);
        }, RECHECK_DELAY_MS));
    }

    private check(document: vscode.TextDocument): void {
        const snapshot = this.store.snapshot;
        if (!snapshot || !isSubmitScript(document, this.selector)) {
            this.collection.delete(document.uri);
            return;
        }

        const lines = Array.from({ length: document.lineCount }, (_, line) => document.lineAt(line).text);
        const problems = findGpuTypeProblems(
            analyzeScript(lines),
            snapshot.usage.entries,
            snapshot.loads.map(load => load.partition),
        );

        this.collection.set(document.uri, problems.map(problem => {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(problem.line, problem.start, problem.line, problem.end),
                problem.message,
                vscode.DiagnosticSeverity.Warning,
            );
            diagnostic.source = 'SLURM';
            return diagnostic;
        }));
    }

    private forget(document: vscode.TextDocument): void {
        clearTimeout(this.pendingChecks.get(document.uri.toString()));
        this.pendingChecks.delete(document.uri.toString());
        this.collection.delete(document.uri);
    }
}

/** A file the completions apply to, with `#SBATCH` directives near the top. */
function isSubmitScript(document: vscode.TextDocument, selector: vscode.DocumentSelector): boolean {
    if (vscode.languages.match(selector, document) === 0) {
        return false;
    }

    const header = document.getText(new vscode.Range(0, 0, Math.min(document.lineCount, 50), 0));
    return header.includes('#SBATCH');
}
