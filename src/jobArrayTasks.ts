export interface ArrayTaskRange {
    start: number;
    end: number;
    step: number;
}

/** The task expression from an array row or individual task ID, without its throttle. */
export function readArrayTaskList(jobId: string): string | undefined {
    const match = /^\d+(?:_(\d+)|_?\[([\d,:-]+)(?:%\d+)?\])$/.exec(jobId);
    return match?.[1] ?? match?.[2];
}

export function parseArrayTaskRanges(taskList: string): ArrayTaskRange[] {
    return taskList.split(',').map(part => {
        const match = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/.exec(part);
        if (!match) {
            throw new RangeError(`Invalid Slurm array task range: ${part}`);
        }

        const start = Number(match[1]);
        const end = Number(match[2] ?? match[1]);
        const step = Number(match[3] ?? 1);
        if (![start, end, step].every(Number.isSafeInteger) || end < start || step === 0) {
            throw new RangeError(`Invalid Slurm array task range: ${part}`);
        }
        return { start, end, step };
    });
}

export function* arrayTaskIndices(ranges: readonly ArrayTaskRange[]): Iterable<number> {
    for (const { start, end, step } of ranges) {
        for (let index = start; index <= end; index += step) {
            yield index;
        }
    }
}

export function includesArrayTask(ranges: readonly ArrayTaskRange[], index: number): boolean {
    return ranges.some(({ start, end, step }) => index >= start && index <= end && (index - start) % step === 0);
}

/** The last index a range reaches, which a step can leave short of its end (`1-9:3` reaches 7). */
export function lastArrayTaskIndex({ start, end, step }: ArrayTaskRange): number {
    return end - ((end - start) % step);
}

/** Whether two ranges share an index, without listing them. */
export function rangesOverlap(a: ArrayTaskRange, b: ArrayTaskRange): boolean {
    const low = Math.max(a.start, b.start);
    const high = Math.min(lastArrayTaskIndex(a), lastArrayTaskIndex(b));
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

export function arrayTaskJobId(arrayJobId: string, taskList: string): string {
    return /^\d+$/.test(taskList) ? `${arrayJobId}_${taskList}` : `${arrayJobId}_[${taskList}]`;
}

/** Format a nonempty set of indices as consecutive ranges, preserving singletons. */
export function formatArrayTaskList(indices: number[]): string {
    indices.sort((a, b) => a - b);
    const parts: string[] = [];
    let start = indices[0];
    let end = start;
    for (const index of indices.slice(1)) {
        if (index > end + 1) {
            parts.push(start === end ? String(start) : `${start}-${end}`);
            start = index;
        }
        end = index;
    }
    parts.push(start === end ? String(start) : `${start}-${end}`);
    return parts.join(',');
}

/** Validation shared by the Cancel, Hold, and Release index pickers. */
export function validateArrayTaskSelection(value: string, bounds?: { minIndex: number; maxIndex: number } | null): string | undefined {
    if (!/^\d+(?:-\d+(?::\d+)?)?(?:,\d+(?:-\d+(?::\d+)?)?)*$/.test(value)) {
        return 'Use an index (3), a range (0-10), a stepped range (0-10:2), or a list of them (1-3,5,8-12:2)';
    }
    let ranges: ArrayTaskRange[];
    try {
        ranges = parseArrayTaskRanges(value);
    } catch (error) {
        return error instanceof Error ? error.message : 'Invalid task selection';
    }
    if (ranges.some((range, index) => ranges.slice(index + 1).some(other => rangesOverlap(range, other)))) {
        return 'Duplicate indices detected';
    }
    if (bounds && ranges.some(range => range.start < bounds.minIndex || lastArrayTaskIndex(range) > bounds.maxIndex)) {
        return `Indices must be within the array range ${bounds.minIndex}-${bounds.maxIndex}`;
    }
    return undefined;
}
