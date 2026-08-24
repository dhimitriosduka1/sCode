import * as path from 'path';

/**
 * Which copy of a submit script a resubmission should use.
 *
 * `snapshot` is the copy taken when the job was originally submitted, so it
 * reruns exactly what ran before. `current` is the file that lives at the
 * original path today, which is what you want after fixing a bug.
 */
export type ResubmitOrigin = 'snapshot' | 'current';

/**
 * Script locations available for resubmitting a job.
 */
export interface ResubmitCandidate {
    /** Copy of the script taken at submission time, if one was cached */
    snapshotPath?: string;
    /** Path the script was submitted from, if the file is still on disk */
    currentPath?: string;
    /** Working directory the original job ran in */
    workDir?: string;
    /** True when the snapshot and the current file no longer match */
    changed?: boolean;
}

/**
 * A resolved resubmission: the script to hand to sbatch and where to run it from.
 */
export interface ResubmitPlan {
    scriptPath: string;
    workDir?: string;
    origin: ResubmitOrigin;
}

const UNUSABLE_PATHS = new Set(['', 'n/a', 'unknown', '(null)', 'null', 'none', '(none)']);

/**
 * Check whether a recorded path is something we can actually submit from.
 */
export function isUsableResubmitPath(value: string | undefined): boolean {
    if (value === undefined) {
        return false;
    }
    return !UNUSABLE_PATHS.has(value.trim().toLowerCase());
}

/**
 * Human-readable label for where a resubmitted script came from.
 */
export function describeResubmitOrigin(origin: ResubmitOrigin): string {
    return origin === 'snapshot' ? 'as originally submitted' : 'current version on disk';
}

/**
 * Pick which script to use when the user has not been asked to choose.
 *
 * The snapshot wins because it is the only copy guaranteed to still exist and
 * to match what actually ran. When it is missing, fall back to the file on disk.
 */
export function pickDefaultResubmitOrigin(candidate: ResubmitCandidate): ResubmitOrigin | undefined {
    if (isUsableResubmitPath(candidate.snapshotPath)) {
        return 'snapshot';
    }
    if (isUsableResubmitPath(candidate.currentPath)) {
        return 'current';
    }
    return undefined;
}

/**
 * True when the user should be asked which version to resubmit.
 *
 * Only worth asking when both copies exist and they actually differ.
 */
export function shouldPromptForResubmitOrigin(candidate: ResubmitCandidate): boolean {
    return Boolean(
        candidate.changed &&
        isUsableResubmitPath(candidate.snapshotPath) &&
        isUsableResubmitPath(candidate.currentPath)
    );
}

/**
 * Work out which directory a resubmitted job should run from.
 *
 * The snapshot lives in the extension's storage directory, so submitting it
 * without an explicit working directory would run the job from there instead of
 * where the user's data is. Prefer the recorded working directory, then the
 * directory the script was originally submitted from.
 */
export function resolveResubmitWorkDir(candidate: ResubmitCandidate): string | undefined {
    if (isUsableResubmitPath(candidate.workDir)) {
        return candidate.workDir;
    }
    if (isUsableResubmitPath(candidate.currentPath)) {
        return path.dirname(candidate.currentPath as string);
    }
    return undefined;
}

/**
 * Build the plan for a resubmission, or undefined when the chosen copy is gone.
 */
export function buildResubmitPlan(candidate: ResubmitCandidate, origin: ResubmitOrigin): ResubmitPlan | undefined {
    const scriptPath = origin === 'snapshot' ? candidate.snapshotPath : candidate.currentPath;
    if (!isUsableResubmitPath(scriptPath)) {
        return undefined;
    }

    return {
        scriptPath: scriptPath as string,
        workDir: resolveResubmitWorkDir(candidate),
        origin,
    };
}

/**
 * Confirmation prompt shown before a resubmission actually reaches the cluster.
 *
 * Split in two because VS Code renders `message` large and bold and `detail` as
 * secondary text; putting everything in `message` makes the whole dialog shout.
 */
export interface ResubmitConfirmation {
    message: string;
    detail?: string;
}

export function formatResubmitConfirmation(
    jobName: string,
    jobId: string,
    plan: ResubmitPlan,
    options: { originAlreadyChosen?: boolean } = {}
): ResubmitConfirmation {
    const message = `Resubmit "${jobName}"?`;

    // Having just picked a version from the diff, the user knows exactly what
    // they asked for; repeating it back is noise. Plain yes/no, as elsewhere.
    if (options.originAlreadyChosen) {
        return { message };
    }

    // The snapshot lives in the extension's private storage, so its path is
    // noise to the user; which version it is, is the part that matters.
    const lines = [`Job ${jobId} \u00b7 ${describeResubmitOrigin(plan.origin)}`];

    if (plan.workDir) {
        lines.push(`Working directory: ${plan.workDir}`);
    }

    lines.push('', 'Code, data, and environment are used as they are now.');

    return { message, detail: lines.join('\n') };
}
