import {
    calculateProgress,
    calculateRemainingSeconds,
    formatDuration,
    formatRemainingTime,
    formatStartTime,
    generateProgressBar,
    getPendingReasonInfo,
    getStateDescription,
    isJobHeld,
    isNearTimeLimit,
    SlurmJob,
} from './slurmService';

import type { DependencyStatus } from './jobDependencies';

export type ActiveJobCategory = 'running' | 'pending' | 'held' | 'neverRuns' | 'completing' | 'other';

/**
 * The tree ID and default open state of an Active Jobs group. Without an ID
 * VS Code knows a group by its label, which carries the count, so holding or
 * releasing a job made Held look like a new group and reopened it in its
 * default state; the ID keeps it as the user left it. An empty group, which
 * shows collapsed so its label lines up with the others, has an ID of its own,
 * so the group opens in its default state (Held closed, the rest open) once
 * jobs arrive rather than staying closed.
 */
export function getCategoryGroupState(category: ActiveJobCategory, jobCount: number): { id: string; expanded: boolean } {
    const id = `slurmJobs.category.${category}`;
    return jobCount === 0
        ? { id: `${id}.empty`, expanded: false }
        : { id, expanded: category !== 'held' };
}

/**
 * The `contextValue` of an Active Jobs group header, which package.json's
 * menus match to offer its actions. An empty group offers none. Held jobs
 * always go to Held, so Pending only ever holds jobs that can be held.
 */
export function getCategoryContextValue(category: ActiveJobCategory, jobCount: number): string {
    if (jobCount === 0) {
        return 'statusCategoryEmpty';
    }
    const headers: Partial<Record<ActiveJobCategory, string>> = {
        running: 'statusCategoryRunning',
        pending: 'statusCategoryPending',
        held: 'statusCategoryHeld',
        neverRuns: 'statusCategoryNeverRuns',
    };
    return headers[category] ?? 'statusCategory';
}

/**
 * Which of a group's rows its Cancel All may cancel. When Active Jobs could not
 * split an array row per task, the row keeps squeue's joined reasons
 * (`Priority,JobHeldUser`): some of its tasks are held and some only wait, and
 * which is which isn't known, so cancelling it from either group would cancel
 * tasks that group doesn't hold. Such rows are `skipped`.
 */
export function getGroupCancelRows<T extends Pick<SlurmJob, 'pendingReason'>>(jobs: readonly T[]): { cancel: T[]; skipped: T[] } {
    const mixed = (job: T) => {
        const held = (job.pendingReason ?? '').split(',').map(reason => isJobHeld(reason.trim()));
        return held.includes(true) && held.includes(false);
    };
    return { cancel: jobs.filter(job => !mixed(job)), skipped: jobs.filter(mixed) };
}

/** `dependency` is what the rest of the queue says about the job's dependency, as for its row. */
export function getActiveJobCategory(
    job: Pick<SlurmJob, 'jobId' | 'state' | 'pendingReason'>,
    dependency?: DependencyStatus,
): ActiveJobCategory | undefined {
    switch (job.state) {
        case 'R':
        case 'CF':
            return 'running';
        case 'PD':
            // Before Held: releasing a job that can never start would not help
            if (dependency?.kind === 'never') {
                return 'neverRuns';
            }
            // A held array row (`123_[4-9]`, or a task like `123_4`) goes to Held
            // too: holding some tasks splits them into a row of their own
            return isJobHeld(job.pendingReason) ? 'held' : 'pending';
        case 'CG':
            return 'completing';
        case 'CD':
        case 'F':
        case 'TO':
        case 'CA':
        case 'NF':
        case 'PR':
        case 'S':
            return 'other';
    }
}

export interface SlurmJobRowParts {
    label: string;
    description: string;
}

/** `dependency` is what the rest of the queue says about the job's dependency, for pending jobs. */
export function getSlurmJobRowParts(job: SlurmJob, dependency?: DependencyStatus): SlurmJobRowParts {
    if (job.state === 'R') {
        const progress = calculateProgress(job.time, job.timeLimit);
        if (progress >= 0) {
            const label = `${job.name}  ${job.jobId}`;
            // Close to the wall clock the percentage stops being the number
            // worth reading: what matters is how long is left to checkpoint or
            // requeue. The bar still carries the proportion, so the percentage
            // gives up its slot rather than crowding in beside it.
            const remaining = isNearTimeLimit(job)
                ? formatRemainingTime(calculateRemainingSeconds(job.time, job.timeLimit))
                : undefined;

            return {
                label,
                description: generateProgressBar(progress, 8, remaining),
            };
        }

        return {
            label: job.name,
            description: `${job.jobId} • ${job.time}`,
        };
    }

    return {
        label: job.name,
        description: createStandardJobDescription(job, dependency),
    };
}

function createStandardJobDescription(job: SlurmJob, dependency: DependencyStatus | undefined): string {
    const parts: string[] = [job.jobId];

    // First, so it lines up across the pending rows
    if (job.state === 'PD' && job.queuedSeconds !== undefined) {
        parts.push(`Queued ${formatDuration(job.queuedSeconds)}`);
    }

    // Waiting on other jobs, the useful fact is which: Slurm gives no start
    // estimate for such a job, and "Waiting on dependency" says less than the
    // jobs' names do. A job that can never start says so instead, and why.
    if (job.state === 'PD' && dependency) {
        if (dependency.kind === 'never') {
            parts.push(`never runs: ${describeNeverRuns(dependency)}`);
        } else {
            // Another reason (a hold) still applies on top of the dependency
            const reasonInfo = job.pendingReason !== 'Dependency' ? getPendingReasonInfo(job.pendingReason) : undefined;
            if (reasonInfo) {
                parts.push(reasonInfo.label);
            }
            parts.push(`after ${listJobs(dependency.jobs, dependency.anyOf ? 'or' : '+', dependency.anyOf ? 'any of ' : '')}`);
        }
        return parts.join(' • ');
    }

    if (job.state === 'PD') {
        const reasonInfo = getPendingReasonInfo(job.pendingReason);
        if (reasonInfo) {
            parts.push(reasonInfo.label);
        }

        const startStr = formatStartTime(job.startTime);
        parts.push(`Starts: ~${startStr}`);

        if (job.dependency) {
            parts.push('🔗');
        }
    } else {
        parts.push(getStateDescription(job.state));
    }

    return parts.join(' • ');
}

function describeNeverRuns(dependency: Extract<DependencyStatus, { kind: 'never' }>): string {
    const ended = [
        ...(dependency.failed.length > 0 ? [`${listJobs(dependency.failed, '+', '')} failed`] : []),
        ...(dependency.succeeded.length > 0 ? [`${listJobs(dependency.succeeded, '+', '')} succeeded`] : []),
    ];
    if (ended.length > 0) {
        return ended.join(', ');
    }
    if (dependency.waitsOn.length > 0) {
        return `waits on ${listJobs(dependency.waitsOn, '+', '')}`;
    }
    return 'dependency failed';
}

/** One or two jobs by name; more as a count, which fits a row where names would not. */
function listJobs(jobs: string[], joiner: string, countPrefix: string): string {
    if (jobs.length === 1) {
        return jobs[0];
    }
    if (jobs.length === 2) {
        return `${jobs[0]} ${joiner} ${jobs[1]}`;
    }
    return `${countPrefix}${jobs.length} jobs`;
}
