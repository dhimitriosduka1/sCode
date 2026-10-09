/**
 * Reads Slurm options out of submit-script lines: `#SBATCH` directives and
 * `srun`/`salloc`/`sbatch` command lines. Shared by the completions that
 * suggest option values, so every option is recognised in the same forms.
 */

/** An option that takes a value, in the spellings Slurm accepts. */
export interface SlurmOptionSpec {
    /** Matches the long option token without its value, e.g. `--gres` */
    long: RegExp;
    /** The short form, e.g. `-p`, which also takes its value attached (`-pgpu`) */
    short?: string;
}

// sbatch/srun/salloc accept any unambiguous prefix of a long option; `--par` and
// shorter collide with `--parsable`, so `--part` is the shortest that is unique.
export const PARTITION_OPTION: SlurmOptionSpec = {
    long: /^--part(?:i(?:t(?:i(?:o(?:n)?)?)?)?)?$/,
    short: '-p',
};

/** Where a line's options come from: a directive, or the command it runs. */
export type SlurmLineKind = 'directive' | 'srun' | 'salloc' | 'sbatch';

/** The value of an option being typed at the cursor. */
export interface OptionValueAtCursor {
    /** The option as written, e.g. `--gres` or `-G` */
    option: string;
    /** Column where the value starts, after any opening quote */
    valueStart: number;
    kind: SlurmLineKind;
    /** Column where this directive's or command's options start, for reading its other options */
    segmentStart: number;
}

const SBATCH_DIRECTIVE = /^\s*#SBATCH(?=\s)/;
const SLURM_COMMAND = /(?:^|[\s;|&(`])(srun|salloc|sbatch)(?=\s)/g;

interface Token {
    text: string;
    start: number;
}

/** Comments never take options, except the #SBATCH directives themselves (and not disabled `##SBATCH`). */
export function isPlainComment(text: string): boolean {
    return /^\s*#/.test(text) && !SBATCH_DIRECTIVE.test(text);
}

/**
 * Finds the value of `spec` being typed at `cursor`, in any of its forms:
 * `--opt=v`, `--opt v`, `-o v`, `-ov`, on an `#SBATCH` line or as one of an
 * `srun`/`salloc`/`sbatch` command's own options (not the launched program's).
 */
export function findOptionValueAtCursor(line: string, cursor: number, spec: SlurmOptionSpec): OptionValueAtCursor | undefined {
    const before = line.slice(0, cursor);
    if (isPlainComment(before)) {
        return undefined;
    }

    const segment = findSegment(before);
    if (!segment) {
        return undefined;
    }

    const tokens = tokenize(before, segment.start);
    const found = findValueInLastToken(tokens, spec);
    if (!found || (segment.kind !== 'directive' && !isInCommandOptions(tokens, found.optionIndex))) {
        return undefined;
    }

    // Skip an opening quote: `--partition="a,b"`
    const firstChar = before.charAt(found.valueStart);
    const valueStart = firstChar === '"' || firstChar === "'" ? found.valueStart + 1 : found.valueStart;
    return { option: found.option, valueStart, kind: segment.kind, segmentStart: segment.start };
}

/** One value given to an option on a line, with where it sits. */
export interface OptionOccurrence {
    /** The option as written, e.g. `--gres` or `-G` */
    option: string;
    /** The value without quotes */
    value: string;
    /** Column where the value starts, after any opening quote */
    valueStart: number;
}

/** A directive or a Slurm command on a line, whose options start at `start`. */
export interface LineSegment {
    start: number;
    kind: SlurmLineKind;
}

/**
 * Every value given to `spec` in a directive's or command's options, with
 * where each sits on the line; later values override earlier ones in Slurm.
 */
export function findOptionOccurrencesInSegment(line: string, segment: LineSegment, spec: SlurmOptionSpec): OptionOccurrence[] {
    const tokens = tokenize(line, segment.start).filter(token => token.text.length > 0);
    const occurrences: OptionOccurrence[] = [];

    for (let index = 0; index < tokens.length; index++) {
        if (segment.kind !== 'directive' && !isInCommandOptions(tokens, index)) {
            break;
        }

        const token = tokens[index];
        const attached = readAttachedValue(token.text, spec);
        if (attached !== undefined) {
            occurrences.push(toOccurrence(attached.option, attached.value, token.start + attached.offset));
        } else if (isBareOption(token.text, spec) && tokens[index + 1] && !tokens[index + 1].text.startsWith('-')) {
            occurrences.push(toOccurrence(token.text, tokens[index + 1].text, tokens[index + 1].start));
            index++;
        }
    }

    return occurrences.filter(occurrence => occurrence.value.length > 0);
}

function toOccurrence(option: string, rawValue: string, rawStart: number): OptionOccurrence {
    const quoted = rawValue.startsWith('"') || rawValue.startsWith("'");
    return { option, value: unquote(rawValue), valueStart: quoted ? rawStart + 1 : rawStart };
}

/**
 * The directive or Slurm commands on a full line, in order. A line can run
 * several commands (`srun -p a x && srun -p b y`); each reads only its own options.
 */
export function findLineSegments(line: string): LineSegment[] {
    if (isPlainComment(line)) {
        return [];
    }

    const directive = line.match(SBATCH_DIRECTIVE);
    if (directive) {
        return [{ start: directive[0].length, kind: 'directive' }];
    }

    return [...line.matchAll(SLURM_COMMAND)].map(match => ({
        start: (match.index ?? 0) + match[0].length,
        kind: match[1] as SlurmLineKind,
    }));
}

/** Whether a line is an `#SBATCH` directive. */
export function isDirective(line: string): boolean {
    return SBATCH_DIRECTIVE.test(line);
}

/**
 * Which value applies to a line, following how Slurm combines a script's
 * header with its commands: directives use the header's value; a command's
 * own value wins; a job step (`srun`, `salloc`) otherwise runs inside the job,
 * so the header applies; an `sbatch` line submits another script, whose
 * header this one can't know. Empty means unknown, so anything goes.
 */
export function resolveLineOrScript<T>(kind: SlurmLineKind, lineValues: T[], scriptValues: T[]): T[] {
    if (kind === 'directive') {
        return scriptValues;
    }
    if (lineValues.length > 0) {
        return lineValues;
    }
    return kind === 'sbatch' ? [] : scriptValues;
}

/** The partitions a directive or command names itself; a later partition option overrides an earlier one. */
export function readSegmentPartitions(line: string, segment: LineSegment): string[] {
    const occurrences = findOptionOccurrencesInSegment(line, segment, PARTITION_OPTION);
    return occurrences.length > 0 ? splitList(occurrences[occurrences.length - 1].value) : [];
}

/** Splits a comma-separated option value, dropping empty items. */
export function splitList(value: string): string[] {
    return value.split(',').map(item => item.trim()).filter(item => item.length > 0);
}

function findSegment(before: string): { start: number; kind: SlurmLineKind } | undefined {
    const directive = before.match(SBATCH_DIRECTIVE);
    if (directive) {
        return { start: directive[0].length, kind: 'directive' };
    }

    let segment: { start: number; kind: SlurmLineKind } | undefined;
    for (const match of before.matchAll(SLURM_COMMAND)) {
        segment = { start: (match.index ?? 0) + match[0].length, kind: match[1] as SlurmLineKind };
    }
    return segment;
}

/**
 * The last token is the one under the cursor. It is the option's value when
 * it is the `=`/attached part of the option, or follows a bare one.
 */
function findValueInLastToken(tokens: Token[], spec: SlurmOptionSpec): { option: string; optionIndex: number; valueStart: number } | undefined {
    if (tokens.length === 0) {
        return undefined;
    }

    const current = tokens[tokens.length - 1];
    const attached = readAttachedValue(current.text, spec);
    if (attached) {
        return { option: attached.option, optionIndex: tokens.length - 1, valueStart: current.start + attached.offset };
    }

    const previous = tokens[tokens.length - 2];
    if (previous && !current.text.startsWith('-') && isBareOption(previous.text, spec)) {
        return { option: previous.text, optionIndex: tokens.length - 2, valueStart: current.start };
    }

    return undefined;
}

/** `--opt=value` or `-ovalue`, with the value's offset within the token. */
function readAttachedValue(text: string, spec: SlurmOptionSpec): { option: string; value: string; offset: number } | undefined {
    const equals = text.indexOf('=');
    if (text.startsWith('--') && equals > 0 && spec.long.test(text.slice(0, equals))) {
        return { option: text.slice(0, equals), value: text.slice(equals + 1), offset: equals + 1 };
    }

    if (spec.short && text.startsWith(spec.short) && text.length > spec.short.length && !text.startsWith('--')) {
        return { option: spec.short, value: text.slice(spec.short.length), offset: spec.short.length };
    }

    return undefined;
}

function isBareOption(text: string, spec: SlurmOptionSpec): boolean {
    return text === spec.short || spec.long.test(text);
}

function unquote(value: string): string {
    return value.replace(/^["']|["']$/g, '');
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
    const segment = text.slice(offset);

    for (const match of segment.matchAll(/\S+/g)) {
        tokens.push({ text: match[0], start: offset + (match.index ?? 0) });
    }

    // A trailing space means the cursor starts a new, empty token
    if (/\s$/.test(segment) || segment.length === 0) {
        tokens.push({ text: '', start: text.length });
    }

    return tokens;
}
