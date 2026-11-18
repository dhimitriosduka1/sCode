/** Count jobs represented by complete Slurm job IDs, including compressed array rows. */
export function countJobs(jobIds: Iterable<string>): number {
    let total = 0;

    for (const jobId of jobIds) {
        const id = jobId.trim();
        const prefix = /^\d+_?\[/.exec(id);
        total += prefix ? countArrayTasks(id, prefix[0].length) : 1;
    }

    return total;
}

function countArrayTasks(jobId: string, taskListStart: number): number {
    // The optional % suffix limits concurrent tasks. Slurm prints disjoint ranges.
    const taskList = /^([\d,:-]+)(?:%\d+)?\]$/.exec(jobId.slice(taskListStart))?.[1];
    if (!taskList) {
        throw new RangeError(`Incomplete or invalid Slurm array job ID: ${jobId}`);
    }

    let count = 0;
    for (const part of taskList.split(',')) {
        const range = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/.exec(part);
        if (!range) {
            throw new RangeError(`Invalid Slurm array task range: ${part}`);
        }

        const start = Number(range[1]);
        const end = Number(range[2] ?? range[1]);
        const step = Number(range[3] ?? 1);
        if (![start, end, step].every(Number.isSafeInteger) || end < start || step === 0) {
            throw new RangeError(`Invalid Slurm array task range: ${part}`);
        }

        count += Math.floor((end - start) / step) + 1;
    }

    return count;
}
