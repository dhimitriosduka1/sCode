import {
    calculateProgress,
    formatStartTime,
    generateProgressBar,
    getPendingReasonInfo,
    getStateDescription,
    SlurmJob,
} from './slurmService';

export interface SlurmJobRowParts {
    label: string;
    description: string;
}

export function getSlurmJobRowParts(job: SlurmJob): SlurmJobRowParts {
    if (job.state === 'R') {
        const progress = calculateProgress(job.time, job.timeLimit);
        if (progress >= 0) {
            const label = `${job.name}  ${job.jobId}`;
            return {
                label,
                description: generateProgressBar(progress, 8),
            };
        }

        return {
            label: job.name,
            description: `${job.jobId} • ${job.time}`,
        };
    }

    return {
        label: job.name,
        description: createStandardJobDescription(job),
    };
}

function createStandardJobDescription(job: SlurmJob): string {
    const parts: string[] = [job.jobId];

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
