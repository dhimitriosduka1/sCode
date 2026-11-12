import {
    calculateProgress,
    calculateRemainingSeconds,
    formatDuration,
    formatRemainingTime,
    formatStartTime,
    generateProgressBar,
    getPendingReasonInfo,
    getStateDescription,
    isNearTimeLimit,
    SlurmJob,
} from './slurmService';

import type { DependencyStatus } from './jobDependencies';

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

/** What the Pending group's header says about `count` of its jobs never running, in the rows' own words. */
export function describeNeverRunCount(count: number): string | undefined {
    if (count === 0) {
        return undefined;
    }
    return count === 1 ? '1 never runs' : `${count} never run`;
}

function createStandardJobDescription(job: SlurmJob, dependency: DependencyStatus | undefined): string {
    const parts: string[] = [job.jobId];

    // First, so it lines up across the pending rows
    if (job.state === 'PD' && job.queuedSeconds !== undefined) {
        parts.push(`queued ${formatDuration(job.queuedSeconds)}`);
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
