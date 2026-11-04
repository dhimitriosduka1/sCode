/**
 * Quotes a value so that a POSIX shell (or tcsh) reads it as one literal word:
 * nothing inside, not `$`, backticks, `;` or spaces, is interpreted. Used for
 * values in Slurm command lines, which run in this machine's shell or, over
 * SSH, the cluster's.
 */
export function quoteForShell(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
