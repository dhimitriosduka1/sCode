import { parseArrayTaskRanges, readArrayTaskList } from './jobArrayTasks';

/** Count jobs represented by complete Slurm job IDs, including compressed array rows. */
export function countJobs(jobIds: Iterable<string>): number {
    let total = 0;

    for (const jobId of jobIds) {
        const id = jobId.trim();
        total += /^\d+_?\[/.test(id) ? countArrayTasks(id) : 1;
    }

    return total;
}

function countArrayTasks(jobId: string): number {
    // The optional % suffix limits concurrent tasks. Slurm prints disjoint ranges.
    const taskList = readArrayTaskList(jobId);
    if (!taskList) {
        throw new RangeError(`Incomplete or invalid Slurm array job ID: ${jobId}`);
    }

    let count = 0;
    for (const { start, end, step } of parseArrayTaskRanges(taskList)) {
        count += Math.floor((end - start) / step) + 1;
    }

    return count;
}
