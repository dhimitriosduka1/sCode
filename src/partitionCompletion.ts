import { CpuPartitionUsage, PartitionUsageEntry } from './slurmService';
import { formatPartitionUsageTooltipMarkdown, getPartitionUsageRatio } from './partitionUsageRanking';
import { formatTooltipMarkdown } from './tooltipMarkdown';
import { findOptionValueAtCursor, isPlainComment, LineSegment, PARTITION_OPTION } from './slurmScriptOptions';

/** Where a partition name is being typed, and which part of the line completing it replaces. */
export interface PartitionCompletionContext {
    /** The partially typed name in the current comma-separated slot */
    prefix: string;
    /** Column range of the current slot, so a half-typed name is replaced whole */
    replaceStart: number;
    replaceEnd: number;
    /** Partitions already named elsewhere in the same list, which should not be offered again */
    alreadyListed: string[];
    /** The directive or command being typed in; absent for `SBATCH_PARTITION`-style variables */
    segment?: LineSegment;
}

const PARTITION_ENVIRONMENT = /(?:^|[\s;])(?:export\s+)?(?:SBATCH|SALLOC|SLURM)_PARTITION=(["']?)[^\s"']*$/;

/**
 * Finds the partition list being typed at `cursor`, covering every way a
 * submit script can name a partition:
 * - `#SBATCH --partition=a`, `--partition a`, `-p a`, `-pa`, and abbreviations like `--part=a`
 * - the same options on `srun`, `salloc`, and `sbatch` command lines
 * - `SBATCH_PARTITION=a`, `SALLOC_PARTITION=a`, and `SLURM_PARTITION=a` (optionally exported)
 *
 * Values may be quoted, and lists like `a,b` complete the slot under the cursor.
 */
export function findPartitionCompletionContext(line: string, cursor: number): PartitionCompletionContext | undefined {
    const before = line.slice(0, cursor);
    if (isPlainComment(before)) {
        return undefined;
    }

    const option = findOptionValueAtCursor(line, cursor, PARTITION_OPTION);
    const valueStart = option?.valueStart ?? findEnvironmentValueStart(before);
    if (valueStart === undefined) {
        return undefined;
    }

    const typedValue = before.slice(valueStart);
    if (/[\s"']/.test(typedValue)) {
        return undefined;
    }

    const typedSlots = typedValue.split(',');
    const prefix = typedSlots[typedSlots.length - 1];
    const slotRemainder = line.slice(cursor).match(/^[^\s"',]*/)?.[0] ?? '';
    const replaceEnd = cursor + slotRemainder.length;
    const laterSlots = line.slice(replaceEnd).match(/^,[^\s"']*/)?.[0].slice(1).split(',') ?? [];

    return {
        prefix,
        replaceStart: cursor - prefix.length,
        replaceEnd,
        alreadyListed: [...typedSlots.slice(0, -1), ...laterSlots].filter(slot => slot.length > 0),
        segment: option && { start: option.segmentStart, kind: option.kind },
    };
}

function findEnvironmentValueStart(before: string): number | undefined {
    const match = before.match(PARTITION_ENVIRONMENT);
    if (!match || match.index === undefined) {
        return undefined;
    }

    const valueAndQuote = match[0].slice(match[0].indexOf('=') + 1);
    return before.length - valueAndQuote.length + match[1].length;
}

/** How busy a partition is, ranked on the resource that matters for it. */
export interface PartitionLoad {
    partition: string;
    /** GPU partitions are ranked on GPUs, the rest on CPUs */
    resource: 'GPU' | 'CPU';
    /** Share of usable capacity allocated, 0–1; 1 when nothing is usable */
    loadRatio: number;
    idle: number;
    pendingJobs?: number;
    gpuUsage?: PartitionUsageEntry;
    cpuUsage?: CpuPartitionUsage;
}

/**
 * Merges GPU and CPU usage into one list of every partition: GPU partitions
 * first, as they are usually what a submit script is after, then CPU-only ones,
 * each least occupied first. GPU partitions use the same load as the GPU
 * Partition Usage view.
 */
export function buildPartitionLoads(
    gpuEntries: PartitionUsageEntry[],
    cpuEntries: CpuPartitionUsage[],
): PartitionLoad[] {
    const loads = new Map<string, PartitionLoad>();

    for (const usage of cpuEntries) {
        const usable = usage.totalCpus - usage.otherCpus;
        loads.set(usage.partition, {
            partition: usage.partition,
            resource: 'CPU',
            loadRatio: usable > 0 ? Math.min(1, usage.allocatedCpus / usable) : 1,
            idle: usage.idleCpus,
            cpuUsage: usage,
        });
    }

    for (const usage of gpuEntries) {
        loads.set(usage.partition, {
            partition: usage.partition,
            resource: 'GPU',
            loadRatio: getPartitionUsageRatio(usage),
            idle: usage.idleGpus,
            pendingJobs: usage.pendingJobs,
            gpuUsage: usage,
        });
    }

    return [...loads.values()].sort((a, b) =>
        RESOURCE_ORDER[a.resource] - RESOURCE_ORDER[b.resource]
        || a.loadRatio - b.loadRatio
        || (a.pendingJobs ?? 0) - (b.pendingJobs ?? 0)
        || b.idle - a.idle
        || a.partition.localeCompare(b.partition)
    );
}

const RESOURCE_ORDER: Record<PartitionLoad['resource'], number> = { GPU: 0, CPU: 1 };

/** A partition to suggest, with any requested GPU types it lacks. */
export interface PartitionSuggestion {
    load: PartitionLoad;
    /** Requested GPU types this partition doesn't have; empty when it fits the request */
    missingGpuTypes: string[];
}

/**
 * Puts partitions offering every requested GPU type first, keeping the
 * least-busy order within each group. Nothing is hidden: the partition is
 * how hardware is chosen, so switching to other GPUs must stay one pick away,
 * with the mismatch spelled out instead.
 */
export function rankPartitionsForGpuTypes(loads: PartitionLoad[], requestedGpuTypes: string[]): PartitionSuggestion[] {
    const requested = [...new Set(requestedGpuTypes)];
    const suggestions = loads.map(load => {
        const offered = new Set(load.gpuUsage?.gpuTypes.map(gpuType => gpuType.type) ?? []);
        return { load, missingGpuTypes: requested.filter(type => !offered.has(type)) };
    });

    return [
        ...suggestions.filter(suggestion => suggestion.missingGpuTypes.length === 0),
        ...suggestions.filter(suggestion => suggestion.missingGpuTypes.length > 0),
    ];
}

/** Short line shown beside the partition name in the completion list. */
export function formatPartitionLoadDescription(load: PartitionLoad, missingGpuTypes: string[] = []): string {
    const description = `${Math.round(load.loadRatio * 100)}% busy · ${load.idle} idle ${load.resource}${load.idle === 1 ? '' : 's'}`;
    return missingGpuTypes.length > 0 ? `${description} · no ${missingGpuTypes.join(', ')}` : description;
}

/** Details panel for the selected completion, matching the GPU Partition Usage tooltip. */
export function formatPartitionLoadDocumentation(load: PartitionLoad): string {
    if (load.gpuUsage) {
        return formatPartitionUsageTooltipMarkdown(load.gpuUsage, { showDefault: false });
    }

    const usage = load.cpuUsage!;
    return formatTooltipMarkdown({
        title: load.partition,
        summary: `${usage.allocatedCpus}/${usage.totalCpus - usage.otherCpus} CPUs · ${usage.idleCpus} idle`,
        details: [
            { label: 'Load', value: `${Math.round(load.loadRatio * 100)}%` },
            { label: 'CPUs', value: `${usage.allocatedCpus} allocated, ${usage.idleCpus} idle, ${usage.otherCpus} unavailable, ${usage.totalCpus} total` },
        ],
    });
}
