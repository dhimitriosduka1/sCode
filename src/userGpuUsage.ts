import type { SlurmJob } from './slurmService';

/** States in which a job holds its GPUs: running, or its nodes being set up. */
const GPU_HOLDING_STATES = new Set(['R', 'CF']);

export interface UserGpuUsage {
    gpuCount: number;
    jobCount: number;
    /** Most GPUs first. */
    types: { type: string; gpuCount: number; jobCount: number }[];
}

/**
 * The GPUs the user's running jobs hold, from what Slurm allocated each one.
 * Pending jobs hold nothing yet.
 */
export function summarizeRunningGpus(jobs: Pick<SlurmJob, 'state' | 'gpuCount' | 'gpuType'>[]): UserGpuUsage {
    const byType = new Map<string, { type: string; gpuCount: number; jobCount: number }>();
    let gpuCount = 0;
    let jobCount = 0;

    for (const job of jobs) {
        if (!GPU_HOLDING_STATES.has(job.state) || !job.gpuCount) {
            continue;
        }
        gpuCount += job.gpuCount;
        jobCount += 1;
        const type = job.gpuType || 'GPU';
        const entry = byType.get(type) ?? { type, gpuCount: 0, jobCount: 0 };
        entry.gpuCount += job.gpuCount;
        entry.jobCount += 1;
        byType.set(type, entry);
    }

    const types = [...byType.values()].sort((a, b) => b.gpuCount - a.gpuCount || a.type.localeCompare(b.type));
    return { gpuCount, jobCount, types };
}

/** `4× A100, 2× H200` */
export function formatGpuTypeBreakdown(usage: UserGpuUsage): string {
    return usage.types.map(({ type, gpuCount }) => `${gpuCount}× ${type}`).join(', ');
}
