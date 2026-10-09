import { CpuPartitionUsage, PartitionUsageEntry } from './slurmService';
import { formatPartitionUsageTooltipMarkdown, getPartitionUsageRatio } from './partitionUsageRanking';
import { formatTooltipMarkdown } from './tooltipMarkdown';

/** Where a partition name is being typed, and which part of the line completing it replaces. */
export interface PartitionCompletionContext {
    /** The partially typed name in the current comma-separated slot */
    prefix: string;
    /** Column range of the current slot, so a half-typed name is replaced whole */
    replaceStart: number;
    replaceEnd: number;
    /** Partitions already named elsewhere in the same list, which should not be offered again */
    alreadyListed: string[];
}

// sbatch/srun/salloc accept any unambiguous prefix of a long option; `--par` and
// shorter collide with `--parsable`, so `--part` is the shortest that is unique.
const LONG_PARTITION_OPTION = /^--part(?:i(?:t(?:i(?:o(?:n)?)?)?)?)?$/;
const LONG_PARTITION_OPTION_WITH_VALUE = /^(--part(?:i(?:t(?:i(?:o(?:n)?)?)?)?)?)=/;
const SHORT_PARTITION_OPTION = '-p';
const SBATCH_DIRECTIVE = /^\s*#SBATCH(?=\s)/;
const SLURM_COMMAND = /(?:^|[\s;|&(`])(srun|salloc|sbatch)(?=\s)/g;
const PARTITION_ENVIRONMENT = /(?:^|[\s;])(?:export\s+)?(?:SBATCH|SALLOC|SLURM)_PARTITION=(["']?)[^\s"']*$/;

interface Token {
    text: string;
    start: number;
}

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
    // Comments never take a partition, except the #SBATCH directives themselves;
    // that also leaves disabled `##SBATCH` lines alone
    if (/^\s*#/.test(before) && !SBATCH_DIRECTIVE.test(before)) {
        return undefined;
    }

    const valueStart = findOptionValueStart(before) ?? findEnvironmentValueStart(before);
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
    };
}

/** Column where the partition value starts, when the cursor is in a partition option's value. */
function findOptionValueStart(before: string): number | undefined {
    const directive = before.match(SBATCH_DIRECTIVE);
    if (directive) {
        const tokens = tokenize(before, directive[0].length);
        return findValueStartInTokens(tokens, false);
    }

    const commandEnd = findLastSlurmCommandEnd(before);
    if (commandEnd === undefined) {
        return undefined;
    }

    return findValueStartInTokens(tokenize(before, commandEnd), true);
}

function findEnvironmentValueStart(before: string): number | undefined {
    const match = before.match(PARTITION_ENVIRONMENT);
    if (!match || match.index === undefined) {
        return undefined;
    }

    const valueAndQuote = match[0].slice(match[0].indexOf('=') + 1);
    return before.length - valueAndQuote.length + match[1].length;
}

function findLastSlurmCommandEnd(before: string): number | undefined {
    let end: number | undefined;
    for (const match of before.matchAll(SLURM_COMMAND)) {
        end = (match.index ?? 0) + match[0].length;
    }
    return end;
}

/**
 * The last token is the one under the cursor. It is a partition value when it
 * is the `=`/attached part of a partition option, or follows a bare one.
 */
function findValueStartInTokens(tokens: Token[], stopAtProgram: boolean): number | undefined {
    if (tokens.length === 0) {
        return undefined;
    }

    const current = tokens[tokens.length - 1];
    const previous = tokens[tokens.length - 2];
    let optionIndex: number;
    let valueStart: number;

    const longWithValue = current.text.match(LONG_PARTITION_OPTION_WITH_VALUE);
    if (longWithValue) {
        optionIndex = tokens.length - 1;
        valueStart = current.start + longWithValue[0].length;
    } else if (current.text.startsWith(SHORT_PARTITION_OPTION) && current.text.length > SHORT_PARTITION_OPTION.length
        && !current.text.startsWith('--')) {
        optionIndex = tokens.length - 1;
        valueStart = current.start + SHORT_PARTITION_OPTION.length;
    } else if (previous && !current.text.startsWith('-')
        && (previous.text === SHORT_PARTITION_OPTION || LONG_PARTITION_OPTION.test(previous.text))) {
        optionIndex = tokens.length - 2;
        valueStart = current.start;
    } else {
        return undefined;
    }

    if (stopAtProgram && !isInCommandOptions(tokens, optionIndex)) {
        return undefined;
    }

    // Skip an opening quote: `--partition="a,b"`
    const firstChar = currentValueFirstChar(tokens[tokens.length - 1], valueStart);
    return firstChar === '"' || firstChar === "'" ? valueStart + 1 : valueStart;
}

function currentValueFirstChar(token: Token, valueStart: number): string | undefined {
    return token.text.charAt(valueStart - token.start) || undefined;
}

/**
 * Whether the token at `optionIndex` is still one of the Slurm command's own
 * options, rather than an argument of the program it launches
 * (`srun python train.py -p 5`). The program starts at the first bare word
 * that can't be the value of the option before it.
 */
function isInCommandOptions(tokens: Token[], optionIndex: number): boolean {
    for (let index = 0; index < optionIndex; index++) {
        const token = tokens[index].text;
        if (token.startsWith('-')) {
            continue;
        }

        const previous = tokens[index - 1]?.text;
        const isOptionValue = previous !== undefined && previous.startsWith('-') && !previous.includes('=');
        if (!isOptionValue) {
            return false;
        }
    }

    return true;
}

function tokenize(text: string, offset: number): Token[] {
    const tokens: Token[] = [];
    const pattern = /\S+/g;
    const segment = text.slice(offset);

    for (const match of segment.matchAll(pattern)) {
        tokens.push({ text: match[0], start: offset + (match.index ?? 0) });
    }

    // A trailing space means the cursor starts a new, empty token
    if (/\s$/.test(segment) || segment.length === 0) {
        tokens.push({ text: '', start: text.length });
    }

    return tokens;
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

/** Short line shown beside the partition name in the completion list. */
export function formatPartitionLoadDescription(load: PartitionLoad): string {
    return `${Math.round(load.loadRatio * 100)}% busy · ${load.idle} idle ${load.resource}${load.idle === 1 ? '' : 's'}`;
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
