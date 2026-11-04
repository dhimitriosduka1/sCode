/**
 * How much of a log on the cluster is fetched: its last 10 MB, which is where
 * a job's outcome is, and little enough to arrive in seconds over SSH even when
 * the job wrote gigabytes.
 */
export const MAX_REMOTE_LOG_BYTES = 10 * 1024 * 1024;

export function formatByteSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The line above a log that only its end is shown of. */
export function formatLogTruncationNotice(totalBytes: number, shownBytes: number = MAX_REMOTE_LOG_BYTES): string {
    return `[Showing the last ${formatByteSize(shownBytes)} of this ${formatByteSize(totalBytes)} log.]\n\n`;
}

/** How often logs open in editors are checked for new output. */
export const LOG_CHECK_INTERVAL_MS = 5_000;

/**
 * Logs over MAX_REMOTE_LOG_BYTES are checked only every this many rounds
 * (30 s): each change re-sends their last 10 MB.
 */
export const LARGE_LOG_CHECK_EVERY = 6;

/** A log's size and modification time, as last read. */
export interface LogVersion {
    size: number;
    mtimeMs: number;
}

/** Whether a log is checked in this round of checks. */
export function isLogCheckDue(read: LogVersion | undefined, round: number): boolean {
    return !read || read.size <= MAX_REMOTE_LOG_BYTES || round % LARGE_LOG_CHECK_EVERY === 0;
}

/** Whether an open log should be read again: it changed, or it was never read (e.g. opened before connecting). */
export function hasLogChanged(read: LogVersion | undefined, now: LogVersion): boolean {
    return !read || read.size !== now.size || read.mtimeMs !== now.mtimeMs;
}
