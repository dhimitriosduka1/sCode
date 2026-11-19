import { cleanJobIdForScontrol, extractBaseJobId, SlurmJob } from './slurmService';
import { countJobs } from './jobCount';
import { ArrayTaskRange, includesArrayTask, parseArrayTaskRanges, readArrayTaskList } from './jobArrayTasks';

/**
 * Dependencies between the user's queued jobs, read from the `Dependency`
 * field squeue already reports for every job, so nothing more is asked of
 * Slurm.
 *
 * Kept free of vscode imports so it can be unit tested directly.
 */

/** One thing a dependency waits for. */
export interface DependencyCondition {
    /** `afterok`, `afterany`, `after`, `singleton`, … in lower case. */
    type: string;
    /**
     * The job waited for, as Slurm names it: `123`, a whole array `123_*`, or
     * one array task `123_4`. Absent for `singleton`, which names no job.
     */
    jobId?: string;
    /** Slurm marked it `(failed)`: the job it waited for ended the wrong way, so it can never be met. */
    failed: boolean;
}

export interface ParsedDependency {
    /** Joined with `?`, so any one condition is enough; otherwise (`,`) every one is needed. */
    anyOf: boolean;
    conditions: DependencyCondition[];
}

/**
 * Reads a dependency as squeue prints it, one job per condition
 * (`afterok:123(unfulfilled),afterok:456_*(failed)`), or as it was typed
 * (`afterok:123:456`). squeue leaves out conditions already met. Undefined when
 * nothing is left to wait for.
 */
export function parseDependency(value: string | undefined): ParsedDependency | undefined {
    const text = value?.trim();
    if (!text || text === '(null)' || text === 'None' || text === 'N/A') {
        return undefined;
    }

    // Slurm allows only one kind of separator in a dependency
    const anyOf = text.includes('?');
    const conditions: DependencyCondition[] = [];
    for (const entry of text.split(anyOf ? '?' : ',')) {
        const match = entry.trim().match(/^([a-z]+)(?::([^()]*))?(?:\((\w+)\))?$/i);
        if (!match) {
            continue;
        }
        const [, rawType, jobIds, state] = match;
        const type = rawType.toLowerCase();
        const failed = state === 'failed';
        if (type === 'singleton') {
            conditions.push({ type, failed });
            continue;
        }
        for (const jobId of (jobIds ?? '').split(':')) {
            // `after:123+10` waits until 10 minutes after 123 starts; the job is still 123
            const id = jobId.replace(/\+\d+$/, '').trim();
            if (/^\d+(_(\d+|\*))?$/.test(id)) {
                conditions.push({ type, jobId: id, failed });
            }
        }
    }

    return conditions.length > 0 ? { anyOf, conditions } : undefined;
}

/** What a pending job's row says about its dependency. */
export type DependencyStatus =
    /** Waits for these jobs: name and ID, or only the ID for jobs not in the queue. `anyOf` when one of them is enough. */
    | { kind: 'waiting'; jobs: string[]; anyOf: boolean }
    /**
     * Can never start as things stand: jobs it needed to succeed `failed`,
     * jobs it needed to fail (`afternotok`) `succeeded`, or it `waitsOn` jobs
     * that themselves never start. All empty when only Slurm's pending reason
     * says so.
     */
    | { kind: 'never'; failed: string[]; succeeded: string[]; waitsOn: string[] };

/**
 * What is being cancelled: a whole job or array (`123`), or some of an array's
 * tasks, as a task list (`4` for `123_4`, `1-3,7` for `123_[1-3,7]`), absent
 * for the tasks still pending.
 */
export type CancelTarget =
    | { base: string; whole: true }
    | { base: string; whole: false; tasks?: string };

/** The cancel target for an ID as passed to scancel. */
export function readCancelTarget(jobId: string): CancelTarget {
    const base = extractBaseJobId(jobId);
    const rest = jobId.slice(base.length).replace(/^_/, '');
    return rest ? { base, whole: false, tasks: rest.replace(/^\[(.*)\]$/, '$1') } : { base, whole: true };
}

/** Parsed task lists, by the list as written, so each row's ranges are read once. */
const parsedTaskLists = new Map<string, ArrayTaskRange[]>();

/** The ranges of a task list (`1-3,7`, `0-9:2%4`), or none when it doesn't parse. */
function taskListRanges(tasks: string): ArrayTaskRange[] {
    let ranges = parsedTaskLists.get(tasks);
    if (!ranges) {
        try {
            ranges = parseArrayTaskRanges(tasks.replace(/%\d+$/, ''));
        } catch {
            ranges = [];
        }
        if (parsedTaskLists.size >= 10_000) {
            parsedTaskLists.clear();
        }
        parsedTaskLists.set(tasks, ranges);
    }
    return ranges;
}

/** The task ranges of an array row (`123_4`, `123_[0-3,7]`), or none for a job that isn't one. */
function rowRanges(jobId: string): ArrayTaskRange[] {
    const tasks = readArrayTaskList(jobId);
    return tasks === undefined ? [] : taskListRanges(tasks);
}

/** Whether `task` is in `tasks`, a task list as the cancel command writes it (`1-3,7`). */
function taskListIncludes(tasks: string, task: number): boolean {
    return includesArrayTask(taskListRanges(tasks), task);
}

/** Whether array row `jobId` holds task `index`, also inside a compressed range (`200_[0-3]` holds 1). */
function rowHasTask(jobId: string, index: number): boolean {
    return includesArrayTask(rowRanges(jobId), index);
}

/** Whether a row holds more than one task. */
function hasSeveralTasks(ranges: readonly ArrayTaskRange[]): boolean {
    return ranges.length > 1 || (ranges.length === 1 && ranges[0].start + ranges[0].step <= ranges[0].end);
}

/** The last index a range reaches, which a step can leave short of its end (`1-9:3` reaches 7). */
function lastIndex({ start, end, step }: ArrayTaskRange): number {
    return end - ((end - start) % step);
}

/** Whether two ranges share an index, without listing them. */
function rangesOverlap(a: ArrayTaskRange, b: ArrayTaskRange): boolean {
    const low = Math.max(a.start, b.start);
    const high = Math.min(lastIndex(a), lastIndex(b));
    if (low > high) {
        return false;
    }
    // Walk the sparser range: the indices of both repeat after the denser one's step
    const [sparse, dense] = a.step >= b.step ? [a, b] : [b, a];
    let index = sparse.start + Math.ceil((low - sparse.start) / sparse.step) * sparse.step;
    for (let tries = 0; tries < dense.step && index <= high; tries++, index += sparse.step) {
        if ((index - dense.start) % dense.step === 0) {
            return true;
        }
    }
    return false;
}

/** Whether any task of `a` is in `b`. */
function anyOverlap(a: readonly ArrayTaskRange[], b: readonly ArrayTaskRange[]): boolean {
    return a.some((range) => b.some((other) => rangesOverlap(range, other)));
}

/**
 * Whether every task of `inner` is in one of `outer`. Runs of tasks one outer
 * range holds are skipped in one go, so a range of thousands of tasks costs
 * about as much as the ranges it is checked against.
 */
function rangesCover(inner: readonly ArrayTaskRange[], outer: readonly ArrayTaskRange[]): boolean {
    for (const range of inner) {
        const last = lastIndex(range);
        let index = range.start;
        while (index <= last) {
            let next: number | undefined;
            for (const other of outer) {
                if (!includesArrayTask([other], index)) {
                    continue;
                }
                // A range whose step divides ours holds our tasks up to its last index; any other, only this one
                const reach = range.step % other.step === 0
                    ? index + Math.floor((lastIndex(other) - index) / range.step) * range.step
                    : index;
                next = Math.max(next ?? reach, reach);
            }
            if (next === undefined) {
                return false;
            }
            index = next + range.step;
        }
    }
    return true;
}

/** Whether cancelling `target` cancels all of `row`, so that the job is over. */
function coversRow(target: CancelTarget, row: SlurmJob): boolean {
    if (target.base !== extractBaseJobId(row.jobId)) {
        return false;
    }
    if (target.whole) {
        return true;
    }
    if (target.tasks === undefined) {
        return row.state === 'PD';
    }
    const ranges = rowRanges(row.jobId);
    return ranges.length > 0 && rangesCover(ranges, taskListRanges(target.tasks));
}

/** How many stranded jobs the cancel dialog names before counting the rest. */
const MAX_LISTED_STRANDED_JOBS = 10;

/**
 * The cancel dialog's explanation of what cancelling `cancelledName` strands.
 * It names the cancelled job rather than saying "it", which could as well mean
 * the pending job. "Without … finishing successfully" holds for jobs further
 * down the chain too.
 */
export function describeStrandedJobs(cancelledName: string, stranded: readonly SlurmJob[]): string {
    const condition = `would never run without "${cancelledName}" finishing successfully`;
    const count = countJobs(stranded.map(job => job.jobId));
    if (count === 1) {
        return `"${stranded[0].name}" (${stranded[0].jobId}) ${condition}.`;
    }
    const listed = stranded.slice(0, MAX_LISTED_STRANDED_JOBS).map((job) => `• ${job.name} (${job.jobId})`);
    if (stranded.length > MAX_LISTED_STRANDED_JOBS) {
        const remaining = stranded.slice(MAX_LISTED_STRANDED_JOBS);
        listed.push(`…and ${countJobs(remaining.map(job => job.jobId))} more`);
    }
    return `These ${count} pending jobs ${condition}:\n\n${listed.join('\n')}`;
}

type Outcome = 'open' | 'broken' | 'brokenByCancel';

/**
 * The dependencies among one snapshot of the user's queue: which pending jobs
 * can never start, and which a cancel would leave unable to start.
 */
export class QueueDependencies {
    private readonly pending: SlurmJob[];
    private readonly byBase = new Map<string, SlurmJob[]>();
    /** Pending jobs that can never start as things stand, by row job ID. */
    private readonly stranded = new Map<string, { failed: string[]; succeeded: string[]; waitsOn: string[] }>();

    constructor(private readonly jobs: readonly SlurmJob[]) {
        for (const job of jobs) {
            const base = extractBaseJobId(job.jobId);
            const rows = this.byBase.get(base);
            if (rows) {
                rows.push(job);
            } else {
                this.byBase.set(base, [job]);
            }
        }
        this.pending = jobs.filter((job) => job.state === 'PD');
        this.findStranded();
    }

    /** Use the base ID for a whole pending array, and exact IDs for a subset. */
    pendingRowCancelIds(rows: readonly SlurmJob[]): string[] {
        const selected = new Set(rows.map(job => job.jobId));
        const wholeArrays = new Set<string>();
        for (const { jobId } of rows) {
            const base = cleanJobIdForScontrol(jobId);
            const arrayRows = this.byBase.get(base);
            if (base !== jobId && arrayRows?.every(job => job.state !== 'PD' || selected.has(job.jobId))) {
                wholeArrays.add(base);
            }
        }
        return unique(rows.map(({ jobId }) => {
            const base = extractBaseJobId(jobId);
            return wholeArrays.has(base) ? base : jobId;
        }));
    }

    /** What `job`'s row should say about its dependency, if anything. */
    describe(job: SlurmJob): DependencyStatus | undefined {
        if (job.state !== 'PD') {
            return undefined;
        }
        const stranded = this.stranded.get(job.jobId);
        if (stranded) {
            return { kind: 'never', ...stranded };
        }

        const parsed = parseDependency(job.dependency);
        if (!parsed) {
            return undefined;
        }
        // Only what can still be met: with `?`, a failed alternative is not being waited for
        const outcomes = this.outcomes(job, parsed, []);
        const waitingFor = unique(parsed.conditions
            .filter((_condition, index) => outcomes[index] === 'open')
            .flatMap((condition) => this.labelsFor(job, condition)));
        return waitingFor.length > 0 ? { kind: 'waiting', jobs: waitingFor, anyOf: parsed.anyOf } : undefined;
    }

    /**
     * The pending jobs that cancelling `target` leaves unable to start, in job
     * ID order: those that need it to finish successfully (`afterok`), and in
     * turn those that need them. They are worked out as if they were cancelled
     * too, which is the choice offered for them, so a job that only waits for
     * one of them to end (`afterany`) is not among them: the cancel lets it run.
     */
    strandedByCancel(target: CancelTarget): SlurmJob[] {
        const targets: CancelTarget[] = [target];
        const result: SlurmJob[] = [];
        let changed = true;
        while (changed) {
            changed = false;
            for (const job of this.pending) {
                if (targets.some((cancelled) => coversRow(cancelled, job))) {
                    continue;
                }
                const parsed = parseDependency(job.dependency);
                if (!parsed) {
                    continue;
                }
                const outcomes = this.outcomes(job, parsed, targets);
                // An already broken dependency does not trigger cancellation.
                if (isNeverMet(parsed.anyOf, outcomes) && outcomes.includes('brokenByCancel')) {
                    // Only this row: other tasks of its array may not depend on the cancelled job
                    result.push(job);
                    targets.push(readCancelTarget(job.jobId));
                    changed = true;
                }
            }
        }
        return result.sort((a, b) => Number(extractBaseJobId(a.jobId)) - Number(extractBaseJobId(b.jobId)));
    }

    /**
     * Which of `rows`, jobs that can never start, to cancel: those that would
     * still never start once the others are cancelled. A job that only waits
     * for one of them to end (`afterany`) is left, since cancelling that one
     * lets it run; the rest of the rows are `freed`.
     */
    neverRunCancelPlan(rows: readonly SlurmJob[]): { cancel: SlurmJob[]; freed: SlurmJob[] } {
        const kept = new Set(rows.map((row) => row.jobId));
        let changed = true;
        while (changed) {
            changed = false;
            for (const row of rows) {
                if (!kept.has(row.jobId)) {
                    continue;
                }
                const parsed = parseDependency(row.dependency);
                if (!parsed) {
                    continue; // Only Slurm's word that it never runs, which a cancel here doesn't change
                }
                const freed = new Set(rows.filter((other) => !kept.has(other.jobId)).map((other) => other.jobId));
                const targets = rows
                    .filter((other) => other !== row && kept.has(other.jobId))
                    .map((other) => readCancelTarget(other.jobId));
                if (isNeverMet(parsed.anyOf, this.outcomes(row, parsed, targets, freed))) {
                    continue;
                }
                // Slurm's own verdict stands when no cancel here is what decides it
                if (row.pendingReason === 'DependencyNeverSatisfied'
                    && !isNeverMet(parsed.anyOf, this.outcomes(row, parsed, [], new Set()))) {
                    continue;
                }
                kept.delete(row.jobId);
                changed = true;
            }
        }
        return {
            cancel: rows.filter((row) => kept.has(row.jobId)),
            freed: rows.filter((row) => !kept.has(row.jobId)),
        };
    }

    /**
     * Fills `stranded` with every pending job that can never start: a condition
     * Slurm marked failed, or one waiting on a job that itself never starts,
     * which no condition type gets past. Repeated until nothing changes, so
     * whole chains below a failure are found.
     */
    private findStranded(): void {
        let changed = true;
        while (changed) {
            changed = false;
            for (const job of this.pending) {
                if (this.stranded.has(job.jobId)) {
                    continue;
                }
                const parsed = parseDependency(job.dependency);
                const outcomes = parsed ? this.outcomes(job, parsed, []) : [];
                // Slurm's own verdict counts even when the string does not show why
                if (!(parsed && isNeverMet(parsed.anyOf, outcomes)) && job.pendingReason !== 'DependencyNeverSatisfied') {
                    continue;
                }
                // A broken condition Slurm did not mark failed waits on a job that never starts
                const labels = (keep: (condition: DependencyCondition, index: number) => boolean) => unique(
                    (parsed?.conditions ?? []).filter(keep).flatMap((condition) => this.labelsFor(job, condition)),
                );
                // Slurm fails afternotok when the job it waits on succeeds
                this.stranded.set(job.jobId, {
                    failed: labels((condition) => condition.failed && condition.type !== 'afternotok'),
                    succeeded: labels((condition) => condition.failed && condition.type === 'afternotok'),
                    waitsOn: labels((condition, index) => !condition.failed && outcomes[index] === 'broken'),
                });
                changed = true;
            }
        }
    }

    /** How each of `job`'s conditions stands, given the jobs about to be cancelled. */
    private outcomes(job: SlurmJob, parsed: ParsedDependency, targets: readonly CancelTarget[], freed?: ReadonlySet<string>): Outcome[] {
        return parsed.conditions.map((condition) => this.outcome(job, condition, targets, freed));
    }

    /** `freed`: stranded rows that the cancel lets run after all. */
    private outcome(job: SlurmJob, condition: DependencyCondition, targets: readonly CancelTarget[], freed?: ReadonlySet<string>): Outcome {
        if (condition.failed) {
            return 'broken';
        }
        if (condition.jobId) {
            // The queue's row for exactly the job or task the condition names, if it has one
            const row = this.jobsFor(job, condition).find((parent) => parent.jobId === condition.jobId);
            if (targets.some((target) => breaksOnCancel(condition, target, row))) {
                return 'brokenByCancel';
            }
        }
        const cancelled = (parent: SlurmJob) => targets.some((target) => coversRow(target, parent));
        const ownTasks = condition.type === 'aftercorr' && !condition.jobId?.includes('_') ? rowRanges(job.jobId) : [];
        // aftercorr needs each task's own partner to succeed, so cancelling the
        // partners of all of a row's tasks fails it. A task whose partner has
        // left the queue has none here, and runs or has failed already
        if (ownTasks.length > 0 && targets.length > 0) {
            const partners = this.jobsFor(job, condition).filter(cancelled);
            if (rangesCover(ownTasks, partners.flatMap((parent) => rowRanges(parent.jobId)))) {
                return 'brokenByCancel';
            }
        }
        // A cancel ends the job, which is all that after, afterany, afternotok and
        // singleton wait for (afternotok counts a cancel as a failure)
        const parents = this.jobsFor(job, condition).filter((parent) => !cancelled(parent));
        const stuck = (parent: SlurmJob) => this.stranded.has(parent.jobId) && !freed?.has(parent.jobId);
        if (hasSeveralTasks(ownTasks)) {
            // A compressed row of tasks: never, only if every task's own partner never starts
            return rangesCover(ownTasks, parents.filter(stuck).flatMap((parent) => rowRanges(parent.jobId)))
                ? 'broken'
                : 'open';
        }
        return parents.some(stuck) ? 'broken' : 'open';
    }

    /**
     * The queued jobs a condition waits for: the array or job it names, or for
     * `singleton`, the user's earlier jobs with the same name. A condition on a
     * single array task matches only a row for exactly that task.
     */
    private jobsFor(job: SlurmJob, condition: DependencyCondition): SlurmJob[] {
        if (!condition.jobId) {
            const base = Number(extractBaseJobId(job.jobId));
            return this.jobs.filter((other) => other.name === job.name
                && Number(extractBaseJobId(other.jobId)) < base);
        }
        const [base, task] = condition.jobId.split('_');
        const rows = this.byBase.get(base) ?? [];
        if (task && task !== '*') {
            // The task's own row, or the compressed row it is still part of (`200_[0-3]` for 200_1)
            return rows.filter((row) => row.jobId === condition.jobId || rowHasTask(row.jobId, Number(task)));
        }
        // aftercorr pairs task with task: a task waits only for the one with its own
        // index. One no longer in the queue has ended, so there is nothing to wait for
        const ownTasks = condition.type === 'aftercorr' ? rowRanges(job.jobId) : [];
        if (ownTasks.length > 0) {
            return rows.filter((row) => anyOverlap(ownTasks, rowRanges(row.jobId)));
        }
        return rows;
    }

    /**
     * How a row names what a condition waits for: name and ID for a job in the
     * queue, since two jobs can share a name; only the ID for one that is not,
     * whose name is not known. A whole array goes by its base ID.
     */
    private labelsFor(job: SlurmJob, condition: DependencyCondition): string[] {
        if (!condition.jobId) {
            return unique(this.jobsFor(job, condition)
                .map((parent) => `${parent.name} (${extractBaseJobId(parent.jobId)})`));
        }
        const [base, task] = condition.jobId.split('_');
        const id = task && task !== '*' ? condition.jobId : base;
        const named = this.byBase.get(base)?.[0];
        return [named ? `${named.name} (${id})` : id];
    }
}

/**
 * Whether cancelling `target` means `condition` can never be met. Only
 * `afterok` needs the job to succeed, and cancelling part of an array fails it
 * on the whole array or on a cancelled task with a `row` of its own in the
 * queue. A task cancelled while still inside its array's pending row
 * (`123_[4-9]`) has no job record, so Slurm drops a dependency on it rather
 * than failing it, and the job runs. `aftercorr` is worked out task by task
 * in `outcome` instead.
 */
function breaksOnCancel(condition: DependencyCondition, target: CancelTarget, row: SlurmJob | undefined): boolean {
    if (condition.type !== 'afterok') {
        return false;
    }
    const [base, task] = (condition.jobId ?? '').split('_');
    if (base !== target.base) {
        return false;
    }
    if (target.whole || !task || task === '*') {
        return true;
    }
    if (!row) {
        return false;
    }
    return target.tasks === undefined ? row.state === 'PD' : taskListIncludes(target.tasks, Number(task));
}

/** Whether conditions with these outcomes can no longer all (or, with `?`, any) be met. */
function isNeverMet(anyOf: boolean, outcomes: Outcome[]): boolean {
    return anyOf
        ? outcomes.every((outcome) => outcome !== 'open')
        : outcomes.some((outcome) => outcome !== 'open');
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}
