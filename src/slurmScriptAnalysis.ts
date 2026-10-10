import { GPU_TYPE_OPTIONS, GpuTypeRequest, readGpuTypeRequests } from './gpuTypeCompletion';
import { PartitionUsageEntry } from './slurmService';
import {
    findLineSegments,
    findOptionOccurrencesInSegment,
    isDirective,
    LineSegment,
    readSegmentPartitions,
    resolveLineOrScript,
} from './slurmScriptOptions';

/** What a script's `#SBATCH` header asks for. */
export interface ScriptHeader {
    /** The last partition directive's list, as the last one wins */
    partitions: string[];
    /** Every GPU type the header's directives request */
    gpuTypes: string[];
}

/** One directive or command, with the partitions and GPU types it names itself. */
export interface SegmentRequest {
    line: number;
    segment: LineSegment;
    partitions: string[];
    gpuTypes: GpuTypeRequest[];
}

/** Everything a script asks Slurm for, line by line. */
export interface ScriptAnalysis {
    header: ScriptHeader;
    /** Header directives, and Slurm commands anywhere in the script */
    segments: SegmentRequest[];
}

/**
 * Reads the `#SBATCH` header. Like sbatch, only directives above the first
 * command count, so reading stops there.
 */
export function readScriptHeader(lines: Iterable<string>): ScriptHeader {
    const header: ScriptHeader = { partitions: [], gpuTypes: [] };

    for (const line of lines) {
        if (isDirective(line)) {
            const request = readSegment(line, 0, findLineSegments(line)[0]);
            if (request.partitions.length > 0) {
                header.partitions = request.partitions;
            }
            header.gpuTypes.push(...request.gpuTypes.map(gpuType => gpuType.type));
        } else if (line.trim() && !/^\s*#/.test(line)) {
            break;
        }
    }

    return header;
}

/** Reads every directive the header counts and every Slurm command in the script. */
export function analyzeScript(lines: string[]): ScriptAnalysis {
    const segments: SegmentRequest[] = [];
    let inHeader = true;

    lines.forEach((line, index) => {
        if (inHeader && line.trim() && !/^\s*#/.test(line)) {
            inHeader = false;
        }

        for (const segment of findLineSegments(line)) {
            // Directives below the first command are ignored by sbatch
            if (segment.kind !== 'directive' || inHeader) {
                segments.push(readSegment(line, index, segment));
            }
        }
    });

    return { header: readScriptHeader(lines), segments };
}

function readSegment(line: string, lineIndex: number, segment: LineSegment): SegmentRequest {
    return {
        line: lineIndex,
        segment,
        partitions: readSegmentPartitions(line, segment),
        gpuTypes: findOptionOccurrencesInSegment(line, segment, GPU_TYPE_OPTIONS).flatMap(readGpuTypeRequests),
    };
}

/** The GPU types requested by a directive or command, under Slurm's header rules. */
export function readLineGpuTypes(line: string, segment: LineSegment): string[] {
    return readSegment(line, 0, segment).gpuTypes.map(gpuType => gpuType.type);
}

/** A GPU type requested where the job can't get it. */
export interface GpuTypeProblem {
    line: number;
    start: number;
    end: number;
    message: string;
}

/**
 * GPU types requested in partitions that don't have them, which Slurm rejects
 * at submission. A type is fine if any of the request's partitions has it, as
 * Slurm runs the job wherever it fits. Requests with no known partition, and
 * partitions missing from `knownPartitions` (possibly typos), are left alone.
 */
export function findGpuTypeProblems(
    analysis: ScriptAnalysis,
    gpuEntries: PartitionUsageEntry[],
    knownPartitions: string[],
): GpuTypeProblem[] {
    const problems: GpuTypeProblem[] = [];

    for (const request of analysis.segments) {
        if (request.gpuTypes.length === 0) {
            continue;
        }

        const partitions = resolveLineOrScript(request.segment.kind, request.partitions, analysis.header.partitions);
        if (partitions.length === 0 || partitions.some(partition => !knownPartitions.includes(partition))) {
            continue;
        }

        const offered = new Set(gpuEntries
            .filter(entry => partitions.includes(entry.partition))
            .flatMap(entry => entry.gpuTypes.map(gpuType => gpuType.type)));

        for (const gpuType of request.gpuTypes) {
            if (!offered.has(gpuType.type)) {
                problems.push({
                    line: request.line,
                    start: gpuType.start,
                    end: gpuType.end,
                    message: describeMissingGpuType(gpuType.type, partitions, offered),
                });
            }
        }
    }

    return problems;
}

/**
 * "No h200 GPUs in partition a100-long. The selected partition only has GPUs
 * of type a100." Partitions are joined with "or" since the job runs in any one.
 */
function describeMissingGpuType(type: string, partitions: string[], offered: Set<string>): string {
    const plural = partitions.length > 1;
    const missing = `No ${type} GPUs in ${plural ? 'partitions' : 'partition'} ${formatList(partitions, 'or')}.`;
    const selected = plural ? 'The selected partitions' : 'The selected partition';
    const types = [...offered].filter(offeredType => offeredType !== 'generic').sort();

    if (offered.size === 0) {
        return `${missing} ${selected} ${plural ? 'have' : 'has'} no GPUs.`;
    }
    if (types.length === 0) {
        return `${missing} ${selected} only ${plural ? 'have' : 'has'} GPUs without a type, so request a count instead, e.g. --gpus=2.`;
    }
    return `${missing} ${selected} only ${plural ? 'have' : 'has'} GPUs of ${types.length > 1 ? 'types' : 'type'} ${formatList(types, 'and')}.`;
}

/** "a", "a and b", "a, b and c" */
function formatList(items: string[], conjunction: 'and' | 'or'): string {
    return items.length > 1 ? `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}` : items.join('');
}
