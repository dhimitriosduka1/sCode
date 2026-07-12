import { getHistoryStateInfo, HistoryJob } from './slurmService';
import { formatTooltipMarkdown } from './tooltipMarkdown';

export interface HistoryDateGroup {
    key: string;
    label: string;
    jobs: HistoryJob[];
}

export function groupHistoryJobsByEndDate(jobs: HistoryJob[], now: Date = new Date()): HistoryDateGroup[] {
    const groups = new Map<string, HistoryJob[]>();

    for (const job of jobs) {
        const date = getHistoryJobDate(job);
        const key = date ? formatDateKey(date) : 'unknown';
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)?.push(job);
    }

    return Array.from(groups.entries()).map(([key, groupedJobs]) => ({
        key,
        label: formatHistoryDateGroupLabel(key, groupedJobs.length, now),
        jobs: groupedJobs,
    }));
}

export function formatHistoryJobDescription(job: HistoryJob, now: Date = new Date()): string {
    const stateInfo = getHistoryStateInfo(job.state, job.exitCode);
    const parts = [
        job.jobId,
        stateInfo.description,
        `ended ${formatHistoryEndedLabel(job.endTime, now)}`,
        formatElapsedTime(job.elapsed),
    ].filter(part => part && part !== 'N/A');

    return parts.join(' • ');
}

export function formatHistorySummaryDescription(
    historyDays: number,
    totalJobs: number,
    filteredJobs: number = totalJobs,
    searchFilter: string = '',
): string {
    const rangeLabel = `Last ${historyDays} day${historyDays === 1 ? '' : 's'}`;
    const jobLabel = totalJobs === 1 ? 'job' : 'jobs';

    if (searchFilter) {
        return `${rangeLabel} · ${filteredJobs} of ${totalJobs} ${jobLabel}`;
    }

    return `${rangeLabel} · ${totalJobs} ${jobLabel}`;
}

export function formatHistorySummaryTooltip(
    refreshedAt: Date,
    historyDays: number,
    totalJobs: number,
    filteredJobs: number,
    searchFilter: string,
): string {
    const details = [
        { label: 'Fetched at', value: refreshedAt.toLocaleString() },
        { label: 'Range', value: `Last ${historyDays} day${historyDays === 1 ? '' : 's'}` },
        { label: 'Jobs', value: searchFilter ? `${filteredJobs} of ${totalJobs}` : totalJobs },
    ];

    if (searchFilter) {
        details.push({ label: 'Filter', value: searchFilter });
    }

    return formatTooltipMarkdown({
        title: 'Job History refresh',
        details,
        note: 'Use Refresh Job History to update it, or Set Job History Range to change the lookback window.',
    });
}

export function normalizeHistoryDays(value: number): number {
    if (!Number.isFinite(value)) {
        return 7;
    }

    return Math.max(1, Math.min(365, Math.floor(value)));
}

function getHistoryJobDate(job: HistoryJob): Date | undefined {
    return parseHistoryDate(job.endTime) ?? parseHistoryDate(job.startTime);
}

function formatHistoryDateGroupLabel(key: string, jobCount: number, now: Date): string {
    const suffix = `(${jobCount})`;
    if (key === 'unknown') {
        return `Unknown date ${suffix}`;
    }

    const date = parseHistoryDate(key);
    if (!date) {
        return `${key} ${suffix}`;
    }

    if (isSameDate(date, now)) {
        return `Today ${suffix}`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (isSameDate(date, yesterday)) {
        return `Yesterday ${suffix}`;
    }

    const label = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
    return `${label} ${suffix}`;
}

function formatHistoryEndedLabel(endTime: string, now: Date): string {
    const date = parseHistoryDate(endTime);
    if (!date) {
        return 'N/A';
    }

    const time = date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });

    if (isSameDate(date, now)) {
        return time;
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (isSameDate(date, yesterday)) {
        return `yesterday ${time}`;
    }

    const day = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
    });
    return `${day} ${time}`;
}

function formatElapsedTime(elapsed: string): string {
    const seconds = parseElapsedSeconds(elapsed);
    if (seconds === undefined) {
        return elapsed;
    }

    if (seconds < 60) {
        return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) {
        return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
    }

    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

function parseElapsedSeconds(elapsed: string): number | undefined {
    if (!elapsed || elapsed === 'N/A' || elapsed === 'Unknown') {
        return undefined;
    }

    let days = 0;
    let timePart = elapsed;
    if (elapsed.includes('-')) {
        const [dayPart, rest] = elapsed.split('-');
        days = parseInt(dayPart, 10) || 0;
        timePart = rest;
    }

    const parts = timePart.split(':').map(part => parseInt(part, 10));
    if (parts.some(part => Number.isNaN(part))) {
        return undefined;
    }

    if (parts.length === 3) {
        return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
    }

    if (parts.length === 2) {
        return days * 86400 + parts[0] * 60 + parts[1];
    }

    if (parts.length === 1) {
        return days * 86400 + parts[0];
    }

    return undefined;
}

function formatDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseHistoryDate(value: string): Date | undefined {
    if (!value || value === 'N/A' || value === 'Unknown') {
        return undefined;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function isSameDate(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}
