import * as path from 'path';
import { SlurmCommandRunner } from './slurmCommandRunner';
import { hasUnresolvedSlurmPathPlaceholders, normalizeSlurmPathValue } from './slurmService';

/**
 * Files on the cluster (logs and submit scripts) for when Slurm commands run
 * there over SSH. Cluster paths are POSIX paths, whatever this machine uses.
 */

/** How much of a file to show: the end, as logs can be far larger than an editor should hold */
export const CLUSTER_FILE_MAX_BYTES = 4 * 1024 * 1024;

export type ClusterFileProblem = 'unresolved' | 'not-found' | 'directory' | 'unreadable';

export class ClusterFileError extends Error {
    constructor(readonly problem: ClusterFileProblem, readonly filePath: string, message: string) {
        super(message);
        this.name = 'ClusterFileError';
    }
}

export interface ClusterFileContent {
    text: string;
    /** Whether the file is longer than what's shown */
    truncated: boolean;
}

/** Expands a leading `~` to the home directory on the cluster; undefined if that's needed and unknown */
export function expandClusterHome(filePath: string, home: string | undefined): string | undefined {
    if (filePath === '~') {
        return home;
    }
    if (filePath.startsWith('~/')) {
        return home ? path.posix.join(home, filePath.slice(2)) : undefined;
    }
    return filePath;
}

/**
 * Turns a path Slurm reported into one to read on the cluster. There's no
 * local folder to resolve a relative path against, so it must end up absolute.
 */
export function resolveClusterPath(filePath: string, home: string | undefined): string {
    const normalized = normalizeSlurmPathValue(filePath);
    if (normalized === 'N/A') {
        throw new ClusterFileError('unresolved', filePath, 'File path not available');
    }

    if (hasUnresolvedSlurmPathPlaceholders(normalized) || normalized.includes('PENDING_NODE')) {
        throw new ClusterFileError(
            'unresolved',
            normalized,
            `Output path is not fully resolved yet: ${normalized}. Refresh after the job starts or finishes.`,
        );
    }

    const expanded = expandClusterHome(normalized, home);
    if (!expanded || !path.posix.isAbsolute(expanded)) {
        throw new ClusterFileError('unresolved', normalized, `Can't tell where ${normalized} is on the cluster`);
    }
    return path.posix.normalize(expanded);
}

/** Explains what's wrong with a folder typed for the cluster, or returns undefined when it's usable */
export function validateClusterFolder(folder: string): string | undefined {
    if (!folder) {
        return 'Enter a folder on the cluster';
    }
    if (/[\0\r\n]/.test(folder)) {
        return 'The folder cannot contain line breaks';
    }
    if (!folder.startsWith('/') && folder !== '~' && !folder.startsWith('~/')) {
        return 'Use an absolute path, or one starting with ~/';
    }
    return undefined;
}

/**
 * The folder on the cluster to submit a local script from: the script's
 * folder within the workspace, mirrored under the workspace's copy on the
 * cluster, so the script's relative paths resolve as they do locally.
 * Scripts outside the workspace are submitted from the copy's root.
 * @returns undefined when the root starts with ~ and the home directory is unknown
 */
export function mapToClusterFolder(
    clusterRoot: string,
    home: string | undefined,
    workspaceRoot: string | undefined,
    scriptPath: string,
): string | undefined {
    const root = expandClusterHome(clusterRoot, home);
    if (!root) {
        return undefined;
    }
    if (!workspaceRoot) {
        return path.posix.normalize(root);
    }

    const relativeDir = path.relative(workspaceRoot, path.dirname(scriptPath));
    if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) {
        return path.posix.normalize(root);
    }
    return path.posix.join(root, ...relativeDir.split(path.sep).filter(Boolean));
}

/** Reads the end of a file on the cluster, up to what an editor should hold. */
export async function readClusterFile(
    run: SlurmCommandRunner,
    filePath: string,
    maxBytes: number = CLUSTER_FILE_MAX_BYTES,
): Promise<ClusterFileContent> {
    let stdout: string;
    try {
        // One byte more than is shown tells whether there's more
        ({ stdout } = await run(['tail', '-c', String(maxBytes + 1), '--', filePath], { maxBuffer: maxBytes + 64 * 1024 }));
    } catch (error) {
        throw classifyReadError(error, filePath);
    }

    if (Buffer.byteLength(stdout, 'utf8') <= maxBytes) {
        return { text: stdout, truncated: false };
    }
    // Start at a whole line rather than partway through one
    const firstLineEnd = stdout.indexOf('\n');
    return { text: firstLineEnd >= 0 ? stdout.slice(firstLineEnd + 1) : stdout, truncated: true };
}

function classifyReadError(error: unknown, filePath: string): unknown {
    const message = error instanceof Error ? error.message : String(error);
    if (/No such file or directory/i.test(message)) {
        return new ClusterFileError('not-found', filePath, message);
    }
    if (/Is a directory/i.test(message)) {
        return new ClusterFileError('directory', filePath, message);
    }
    if (/Permission denied/i.test(message)) {
        return new ClusterFileError('unreadable', filePath, message);
    }
    // Including a lost connection, which callers handle themselves
    return error;
}
