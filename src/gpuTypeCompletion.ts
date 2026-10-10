import { PartitionUsageEntry } from './slurmService';
import {
    findOptionValueAtCursor,
    LineSegment,
    OptionOccurrence,
    readSegmentPartitions,
    SlurmOptionSpec,
} from './slurmScriptOptions';
import { formatTooltipMarkdown } from './tooltipMarkdown';

/**
 * Options whose value names GPU types: `--gres=gpu:<type>[:n]`, and the
 * `[type:]n` form of `--gpus`/`-G` and the per-node/task/socket variants.
 * Only full names: shorter prefixes are ambiguous with `--gres-flags`,
 * `--gpu-bind`, and `--gpu-freq`.
 */
export const GPU_TYPE_OPTIONS: SlurmOptionSpec = {
    long: /^--(?:gres|gpus(?:-per-(?:node|task|socket))?)$/,
    short: '-G',
};

/** Untyped GPUs, as the partition data records them; there is no name to request */
const UNTYPED_GPU = 'generic';

/** Where a GPU type is being typed, and which part of the line completing it replaces. */
export interface GpuTypeCompletionContext {
    /** The partially typed type name */
    prefix: string;
    /** Column range of the type, so a half-typed name is replaced but a `:count` after it is kept */
    replaceStart: number;
    replaceEnd: number;
    /** Types already requested elsewhere in the same list */
    alreadyListed: string[];
    /** The directive or command being typed in */
    segment: LineSegment;
    /** Partitions this directive or command names itself */
    linePartitions: string[];
}

/**
 * Finds the GPU type being typed at `cursor`: after `gpu:` in a `--gres` list
 * item (`--gres=shard:1,gpu:a1`), or the type before `:` in a `--gpus`-style
 * list item (`--gpus=a100:2,h2`).
 */
export function findGpuTypeCompletionContext(line: string, cursor: number): GpuTypeCompletionContext | undefined {
    const at = findOptionValueAtCursor(line, cursor, GPU_TYPE_OPTIONS);
    if (!at) {
        return undefined;
    }

    const typedValue = line.slice(at.valueStart, cursor);
    if (/[\s"']/.test(typedValue)) {
        return undefined;
    }

    const isGres = at.option === '--gres';
    const typedItems = typedValue.split(',');
    const currentItem = typedItems[typedItems.length - 1];
    // In --gres the type follows `gpu:`; elsewhere it is the item's first field
    const typeMatch = isGres ? currentItem.match(/^gpu:([^:]*)$/) : currentItem.match(/^([^:]*)$/);
    if (!typeMatch) {
        return undefined;
    }

    const prefix = typeMatch[1];
    const typeRemainder = line.slice(cursor).match(/^[^\s"',:]*/)?.[0] ?? '';
    const itemEnd = cursor + (line.slice(cursor).match(/^[^\s"',]*/)?.[0].length ?? 0);
    const laterItems = line.slice(itemEnd).match(/^,[^\s"']*/)?.[0].slice(1).split(',') ?? [];

    return {
        prefix,
        replaceStart: cursor - prefix.length,
        replaceEnd: cursor + typeRemainder.length,
        alreadyListed: [...typedItems.slice(0, -1), ...laterItems]
            .map(item => readRequestedType(item, isGres))
            .filter((type): type is string => type !== undefined),
        segment: { start: at.segmentStart, kind: at.kind },
        linePartitions: readSegmentPartitions(line, { start: at.segmentStart, kind: at.kind }),
    };
}

/** The GPU type a list item requests, if it names one (`gpu:a100:2` or `a100:2`, not a bare count). */
function readRequestedType(item: string, isGres: boolean): string | undefined {
    const fields = item.split(':');
    // --gres items are `gpu[:type][:count]`, --gpus items `[type:]count`
    const field = isGres ? (fields[0] === 'gpu' ? fields[1] : undefined) : fields[0];
    return field && !/^\d+$/.test(field) ? field : undefined;
}

/** A GPU type named in a request, and the columns it spans on its line. */
export interface GpuTypeRequest {
    type: string;
    start: number;
    end: number;
}

/** The GPU types a `--gres`/`--gpus`-style option value requests, with their positions. */
export function readGpuTypeRequests(occurrence: OptionOccurrence): GpuTypeRequest[] {
    const isGres = occurrence.option === '--gres';
    const requests: GpuTypeRequest[] = [];
    let itemStart = occurrence.valueStart;

    for (const item of occurrence.value.split(',')) {
        const type = readRequestedType(item, isGres);
        if (type) {
            const start = itemStart + (isGres ? 'gpu:'.length : 0);
            requests.push({ type, start, end: start + type.length });
        }
        itemStart += item.length + 1;
    }
    return requests;
}

/** A GPU type that can be requested, with how many are idle where the job can run. */
export interface GpuTypeAvailability {
    type: string;
    /** The partition where most of this type are idle, since a job runs in one partition */
    best: GpuTypePartitionAvailability;
    /** Every partition in scope offering this type, most idle first */
    partitions: GpuTypePartitionAvailability[];
}

export interface GpuTypePartitionAvailability {
    partition: string;
    idle: number;
    total: number;
}

export type GpuTypeSuggestions =
    | { kind: 'types'; types: GpuTypeAvailability[]; partitionCount: number }
    | { kind: 'none'; reason: string };

/**
 * The GPU types to suggest for a request running in `partitions` (all GPU
 * partitions when empty), most idle first. Idle counts are not summed across
 * partitions: overlapping partitions share nodes, and a job runs in only one.
 */
export function buildGpuTypeSuggestions(
    entries: PartitionUsageEntry[],
    partitions: string[],
    alreadyListed: string[],
): GpuTypeSuggestions {
    const inScope = partitions.length > 0
        ? entries.filter(entry => partitions.includes(entry.partition))
        : entries;

    if (inScope.length === 0) {
        const named = partitions.join(', ');
        return { kind: 'none', reason: `${named} ${partitions.length === 1 ? 'has' : 'have'} no GPUs` };
    }

    const byType = new Map<string, GpuTypePartitionAvailability[]>();
    for (const entry of inScope) {
        for (const { type, count } of entry.gpuTypes) {
            if (type === UNTYPED_GPU) {
                continue;
            }
            const partitionsForType = byType.get(type) ?? [];
            partitionsForType.push({ partition: entry.partition, idle: getIdleGpusOfType(entry, type), total: count });
            byType.set(type, partitionsForType);
        }
    }

    const types = [...byType]
        .filter(([type]) => !alreadyListed.includes(type))
        .map(([type, availability]) => {
            const sorted = availability.sort((a, b) => b.idle - a.idle || a.partition.localeCompare(b.partition));
            return { type, best: sorted[0], partitions: sorted };
        })
        .sort((a, b) => b.best.idle - a.best.idle || a.type.localeCompare(b.type));

    if (types.length === 0) {
        return {
            kind: 'none',
            reason: byType.size > 0 ? 'all GPU types already listed' : 'GPUs here have no type; request a count only',
        };
    }

    return { kind: 'types', types, partitionCount: inScope.length };
}

function getIdleGpusOfType(entry: PartitionUsageEntry, type: string): number {
    const idle = entry.idleGpusByType?.find(item => item.type === type);
    if (idle) {
        return idle.count;
    }
    // Without per-type data, a single-type partition's idle GPUs are all of that type
    return entry.idleGpusByType === undefined && entry.gpuTypes.length === 1 ? entry.idleGpus : 0;
}

/** Short line beside the type: idle GPUs, and where, when several partitions are in play. */
export function formatGpuTypeDescription(availability: GpuTypeAvailability, partitionCount: number): string {
    const { best } = availability;
    const counts = `${best.idle} idle of ${best.total}`;
    return partitionCount > 1 ? `${counts} · ${best.partition}` : counts;
}

/** Details panel: the type's availability in each partition in play. */
export function formatGpuTypeDocumentation(availability: GpuTypeAvailability): string {
    return formatTooltipMarkdown({
        title: `GPU type: ${availability.type}`,
        sections: [{
            title: 'Idle by partition',
            lines: availability.partitions.map(({ partition, idle, total }) => `${partition}: ${idle} idle of ${total}`),
        }],
    });
}
