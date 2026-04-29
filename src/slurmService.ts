import * as os from 'os';
import * as path from 'path';
import { JobPathCache } from './jobPathCache';
import { SubmitScriptCache } from './submitScriptCache';
import {
    LocalSlurmExecutor,
    SlurmExecutor,
    validateJobId,
    validateJobState,
    validatePartitionName,
    validateRemoteFilePath,
} from './slurmExecutor';

export type SlurmMockModeProvider = () => boolean;

/**
 * Represents a SLURM job with its properties
 */
export interface SlurmJob {
    jobId: string;
    name: string;
    state: string;
    time: string;
    partition: string;
    nodes: string;
    stdoutPath: string;
    stderrPath: string;
    timeLimit: string;
    startTime: string;
    workDir: string;
    submitScript: string;
    /** Path to the cached copy of the submit script (at submission time) */
    cachedSubmitScript?: string;
    /** GPU name (if available) */
    gpuName?: string;
    /** GPU memory (if available) */
    gpuMemory?: string;
    /** Number of GPUs allocated to this job */
    gpuCount?: number;
    /** GPU type (e.g., H200, A100) */
    gpuType?: string;
    /** Allocated memory (e.g., 500G) */
    memory?: string;
    /** Job dependency string (e.g., afterok:12345) */
    dependency?: string;
    /** Slurm pending reason code (e.g., Resources, Priority, Dependency) */
    pendingReason?: string;
}

/**
 * Job states returned by SLURM
 */
export enum JobState {
    RUNNING = 'R',
    PENDING = 'PD',
    COMPLETING = 'CG',
    COMPLETED = 'CD',
    FAILED = 'F',
    TIMEOUT = 'TO',
    CANCELLED = 'CA',
    NODE_FAIL = 'NF',
    PREEMPTED = 'PR',
    SUSPENDED = 'S',
}

/**
 * Get a human-readable description for a job state
 */
export function getStateDescription(state: string): string {
    const descriptions: Record<string, string> = {
        'R': 'Running',
        'PD': 'Pending',
        'CG': 'Completing',
        'CD': 'Completed',
        'F': 'Failed',
        'TO': 'Timeout',
        'CA': 'Cancelled',
        'NF': 'Node Fail',
        'PR': 'Preempted',
        'S': 'Suspended',
    };
    return descriptions[state] || state;
}

export interface PendingReasonInfo {
    code: string;
    label: string;
    description: string;
}

const PENDING_REASON_INFO: Record<string, Omit<PendingReasonInfo, 'code'>> = {
    AccountingPolicy: {
        label: 'Accounting policy',
        description: 'The job is blocked by an accounting policy or limit.',
    },
    AccountNotAllowed: {
        label: 'Account not allowed',
        description: 'The selected account is not allowed to use this partition.',
    },
    AssociationJobLimit: {
        label: 'Association job limit',
        description: 'The association has reached its maximum job count.',
    },
    AssociationResourceLimit: {
        label: 'Association resource limit',
        description: 'The association has reached a resource limit.',
    },
    AssociationTimeLimit: {
        label: 'Association time limit',
        description: 'The association has reached its time limit.',
    },
    BadConstraints: {
        label: 'Unsatisfiable constraints',
        description: 'The requested constraints cannot be satisfied.',
    },
    BeginTime: {
        label: 'Waiting for begin time',
        description: 'The job cannot start until its requested begin time is reached.',
    },
    BurstBufferOperation: {
        label: 'Burst buffer operation',
        description: 'A burst buffer operation for the job failed or is incomplete.',
    },
    BurstBufferResources: {
        label: 'Burst buffer resources',
        description: 'There are not enough burst buffer resources available.',
    },
    BurstBufferStageIn: {
        label: 'Burst buffer staging',
        description: 'The job is waiting while burst buffer stage-in completes.',
    },
    Cleaning: {
        label: 'Cleaning up',
        description: 'The job is being requeued and is still cleaning up from a previous run.',
    },
    Constraints: {
        label: 'Waiting for constraints',
        description: 'The requested constraints cannot be satisfied right now.',
    },
    DeadLine: {
        label: 'Deadline cannot be met',
        description: 'The job cannot meet its configured deadline.',
    },
    Dependency: {
        label: 'Waiting on dependency',
        description: 'The job depends on another job that has not completed successfully yet.',
    },
    DependencyNeverSatisfied: {
        label: 'Dependency will not complete',
        description: 'The job has a dependency that Slurm believes can never be satisfied.',
    },
    FedJobLock: {
        label: 'Federation lock',
        description: 'The job is waiting for cluster federation synchronization.',
    },
    InactiveLimit: {
        label: 'Inactive limit',
        description: 'The job reached the system inactive limit.',
    },
    InvalidAccount: {
        label: 'Invalid account',
        description: 'The job requested an invalid account.',
    },
    InvalidQOS: {
        label: 'Invalid QOS',
        description: 'The job requested an invalid quality of service.',
    },
    JobArrayTaskLimit: {
        label: 'Array task limit',
        description: 'The job array has reached its limit for simultaneously running tasks.',
    },
    JobHeldAdmin: {
        label: 'Held by admin',
        description: 'The job is being held by an administrator or privileged user.',
    },
    JobHeldUser: {
        label: 'Held by user',
        description: 'The job is being held by the user or an account coordinator.',
    },
    JobHoldMaxRequeue: {
        label: 'Max requeues reached',
        description: 'The job has been requeued too many times and is now held.',
    },
    JobLaunchFailure: {
        label: 'Launch failure',
        description: 'Slurm could not launch the job, possibly due to a file system or executable problem.',
    },
    Licenses: {
        label: 'Waiting for license',
        description: 'The job is waiting for a required license to become available.',
    },
    MaxMemPerLimit: {
        label: 'Memory limit exceeded',
        description: 'The job violates a maximum memory-per-CPU or memory-per-node limit.',
    },
    NodeDown: {
        label: 'Node down',
        description: 'A node required by the job is down.',
    },
    None: {
        label: 'Not evaluated yet',
        description: 'The scheduler has not evaluated this job in the current cycle yet.',
    },
    PartitionConfig: {
        label: 'Partition policy',
        description: 'The job violates a configured partition policy or limit.',
    },
    PartitionDown: {
        label: 'Partition down',
        description: 'The requested partition is down.',
    },
    PartitionInactive: {
        label: 'Partition inactive',
        description: 'The requested partition is inactive and cannot start jobs.',
    },
    PartitionNodeLimit: {
        label: 'Partition node limit',
        description: 'The requested node count is outside the partition limits or required nodes are unavailable.',
    },
    PartitionTimeLimit: {
        label: 'Partition time limit',
        description: 'The job time limit exceeds the partition time limit.',
    },
    Priority: {
        label: 'Waiting on priority',
        description: 'Higher-priority jobs are ahead of this job in the queue.',
    },
    Prolog: {
        label: 'Prolog running',
        description: 'The job is waiting for the prolog program to finish.',
    },
    QOSNotAllowed: {
        label: 'QOS not allowed',
        description: 'The requested quality of service is not allowed for this association or partition.',
    },
    QOSResourceLimit: {
        label: 'QOS resource limit',
        description: 'The job quality of service has reached a resource limit.',
    },
    QOSTimeLimit: {
        label: 'QOS time limit',
        description: 'The job quality of service has reached its time limit.',
    },
    QOSUsageThreshold: {
        label: 'QOS usage threshold',
        description: 'The required quality-of-service usage threshold has been breached.',
    },
    ReqNodeNotAvail: {
        label: 'Requested node unavailable',
        description: 'A specifically requested node is unavailable, reserved, down, drained, or not responding.',
    },
    Reservation: {
        label: 'Waiting for reservation',
        description: 'The job is waiting for its advanced reservation to become available.',
    },
    ReservationDeleted: {
        label: 'Reservation deleted',
        description: 'The job requested a reservation that no longer exists.',
    },
    Resources: {
        label: 'Waiting for resources',
        description: 'The requested CPUs, memory, GPUs, nodes, or other resources are not available right now.',
    },
    SchedDefer: {
        label: 'Scheduler deferred',
        description: 'The scheduler is configured to defer immediate allocations.',
    },
    SystemFailure: {
        label: 'System failure',
        description: 'The job is blocked by a Slurm, file system, network, or other system failure.',
    },
};

function normalizePendingReason(reason: string | undefined): string | undefined {
    const trimmed = reason?.trim();
    if (!trimmed || trimmed === 'N/A' || trimmed === '(null)') {
        return undefined;
    }

    return trimmed.replace(/^\((.*)\)$/, '$1').trim();
}

function splitSlurmReasonCode(code: string): string {
    return code
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/Q O S/g, 'QOS')
        .replace(/G R E S/g, 'GRES')
        .replace(/B B/g, 'BB');
}

function getGenericPendingReasonInfo(code: string): Omit<PendingReasonInfo, 'code'> | undefined {
    if (code.startsWith('AssocGrp')) {
        return {
            label: 'Association group limit',
            description: 'The association has reached an aggregate limit for jobs, time, or resources.',
        };
    }

    if (code.startsWith('AssocMax')) {
        return {
            label: 'Association max limit',
            description: 'The job request exceeds a per-job or per-node limit for this association.',
        };
    }

    if (code.startsWith('Max') && code.includes('PerAccount')) {
        return {
            label: 'Account QOS limit',
            description: 'The job request exceeds a per-account limit on the selected quality of service.',
        };
    }

    if (code.startsWith('QOSGrp')) {
        return {
            label: 'QOS group limit',
            description: 'The selected quality of service has reached an aggregate job, time, or resource limit.',
        };
    }

    if (code.startsWith('QOSMax')) {
        return {
            label: 'QOS max limit',
            description: 'The job request exceeds a maximum limit for the selected quality of service.',
        };
    }

    if (code.startsWith('QOSMin')) {
        return {
            label: 'QOS minimum not met',
            description: 'The job request does not meet a minimum requirement for the selected quality of service.',
        };
    }

    return undefined;
}

/**
 * Translate a Slurm pending reason code into display text.
 */
export function getPendingReasonInfo(reason: string | undefined): PendingReasonInfo | undefined {
    const normalizedReason = normalizePendingReason(reason);
    if (!normalizedReason) {
        return undefined;
    }

    const [code, ...details] = normalizedReason.split(',').map(part => part.trim()).filter(Boolean);
    const knownReason = PENDING_REASON_INFO[code] ?? getGenericPendingReasonInfo(code);
    const detailText = details.length > 0 ? ` Details: ${details.join(', ')}.` : '';

    if (knownReason) {
        return {
            code,
            label: knownReason.label,
            description: `${knownReason.description}${detailText}`,
        };
    }

    const readableCode = splitSlurmReasonCode(code);
    return {
        code,
        label: readableCode,
        description: `Slurm reported: ${readableCode}.${detailText}`,
    };
}

/**
 * Parse a SLURM time string (e.g., "1-00:30:00", "00:30:00", "30:00") to seconds
 */
export function parseTimeToSeconds(timeStr: string): number {
    if (!timeStr || timeStr === 'N/A' || timeStr === 'UNLIMITED' || timeStr === 'INVALID') {
        return -1;
    }

    let days = 0;
    let timePart = timeStr;

    // Handle days format: "D-HH:MM:SS"
    if (timeStr.includes('-')) {
        const [dayPart, rest] = timeStr.split('-');
        days = parseInt(dayPart, 10) || 0;
        timePart = rest;
    }

    const parts = timePart.split(':').map(p => parseInt(p, 10) || 0);

    let hours = 0, minutes = 0, seconds = 0;

    if (parts.length === 3) {
        [hours, minutes, seconds] = parts;
    } else if (parts.length === 2) {
        [minutes, seconds] = parts;
    } else if (parts.length === 1) {
        seconds = parts[0];
    }

    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Calculate progress percentage based on elapsed time and time limit
 */
export function calculateProgress(elapsed: string, limit: string): number {
    const elapsedSec = parseTimeToSeconds(elapsed);
    const limitSec = parseTimeToSeconds(limit);

    if (elapsedSec < 0 || limitSec <= 0) {
        return -1; // Cannot calculate
    }

    const progress = Math.min(100, Math.round((elapsedSec / limitSec) * 100));
    return progress;
}

/**
 * Generate a visual progress bar string
 */
export function generateProgressBar(progress: number, width: number = 10): string {
    if (progress < 0) {
        return '';
    }

    const filled = Math.round((progress / 100) * width);
    const empty = width - filled;

    // Use circle characters for clean visual
    const filledChar = '●';  // Filled circle
    const emptyChar = '○';   // Empty circle
    const progressBar = filledChar.repeat(filled) + emptyChar.repeat(empty);

    return `${progressBar} ${progress}%`;
}

/**
 * Format start time for display
 */
export function formatStartTime(startTime: string): string {
    if (!startTime || startTime === 'N/A' || startTime === 'Unknown') {
        return 'TBD';
    }

    try {
        const date = new Date(startTime);
        if (isNaN(date.getTime())) {
            return startTime; // Return as-is if not parseable
        }

        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();

        if (isToday) {
            return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        } else {
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
        }
    } catch {
        return startTime;
    }
}

/**
 * Expand any remaining SLURM path placeholders
 * scontrol may return unexpanded placeholders for pending jobs or job arrays
 */
export function expandPathPlaceholders(
    pathValue: string,
    jobId: string,
    jobName: string,
    nodes: string,
    workDir?: string,
    options: PathExpansionOptions = {},
): string {
    if (!pathValue) {
        return pathValue;
    }

    let expanded = normalizeSlurmPathValue(pathValue);
    if (expanded === 'N/A') {
        return 'N/A';
    }

    // Common SLURM filename patterns:
    // %j - job ID
    // %J - job ID (step ID is not available here, so use the job ID)
    // %x - job name
    // %u - username (we'll get from os)
    // %N - first node name
    // %n - node index (not available here, so use 0)
    // %A - job array master ID
    // %a - job array index
    // %b - job array index modulo 10
    // %s - step ID
    // %t - task ID
    const percentSentinel = '\u0000SLURM_PERCENT\u0000';
    expanded = expanded.replace(/%%/g, percentSentinel);

    expanded = expanded.replace(/%j/g, jobId);
    expanded = expanded.replace(/%J/g, jobId);
    expanded = expanded.replace(/%x/g, jobName);

    expanded = expanded.replace(/%u/g, options.username ?? getLocalUsernameFallback());

    // Node name - use first node if available, otherwise use placeholder
    if (nodes && nodes !== 'N/A') {
        expanded = expanded.replace(/%N/g, getFirstNodeName(nodes) || nodes);
    } else {
        // For pending jobs, we can't know the node yet - mark as pending
        if (expanded.includes('%N')) {
            expanded = expanded.replace(/%N/g, 'PENDING_NODE');
        }
    }

    // Job array placeholders
    const [jobAllocationId, ...stepParts] = jobId.split('.');
    const arrayParts = jobAllocationId.split('_');
    const arrayIndex = arrayParts.length > 1 ? arrayParts[1] : '0';
    const arrayIndexNumber = parseInt(arrayIndex, 10);
    const stepId = stepParts.length > 0 ? stepParts[stepParts.length - 1] : '0';
    expanded = expanded.replace(/%A/g, arrayParts[0]); // Master job ID
    expanded = expanded.replace(/%a/g, arrayIndex); // Array index
    expanded = expanded.replace(/%b/g, Number.isFinite(arrayIndexNumber) ? String(arrayIndexNumber % 10) : '0');
    expanded = expanded.replace(/%n/g, '0'); // Node index unavailable in this context
    expanded = expanded.replace(/%s/g, stepId); // Step ID
    expanded = expanded.replace(/%t/g, '0'); // Task ID
    expanded = expanded.replace(new RegExp(percentSentinel, 'g'), '%'); // Escaped percent

    if (options.remote) {
        const normalizedWorkDir = normalizeSlurmPathValue(workDir || '');
        if (expanded !== 'N/A' &&
            normalizedWorkDir !== 'N/A' &&
            path.posix.isAbsolute(normalizedWorkDir) &&
            !path.posix.isAbsolute(expanded)) {
            expanded = path.posix.resolve(normalizedWorkDir, expanded);
        }
    } else {
        expanded = normalizeOpenableFilePath(expanded) ?? 'N/A';
        const normalizedWorkDir = normalizeOpenableFilePath(workDir || '');
        if (expanded !== 'N/A' && normalizedWorkDir && !path.isAbsolute(expanded)) {
            expanded = path.resolve(normalizedWorkDir, expanded);
        }
    }

    return expanded;
}

function getLocalUsernameFallback(): string {
    try {
        return os.userInfo().username;
    } catch {
        return 'user';
    }
}

function getFirstNodeName(nodes: string): string | undefined {
    const firstEntry = getFirstNodeListEntry(nodes.trim());
    if (!firstEntry) {
        return undefined;
    }

    const bracketMatch = firstEntry.match(/^(.*)\[([^\]]+)\]$/);
    if (!bracketMatch) {
        return firstEntry;
    }

    const prefix = bracketMatch[1];
    const firstRange = bracketMatch[2].split(',')[0];
    const firstNodeSuffix = firstRange.split('-')[0];
    return firstNodeSuffix ? `${prefix}${firstNodeSuffix}` : firstEntry;
}

function getFirstNodeListEntry(nodes: string): string {
    let bracketDepth = 0;
    for (let index = 0; index < nodes.length; index++) {
        const char = nodes[index];
        if (char === '[') {
            bracketDepth++;
        } else if (char === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (char === ',' && bracketDepth === 0) {
            return nodes.slice(0, index).trim();
        }
    }

    return nodes.trim();
}

/**
 * Job details fetched from scontrol
 */
export interface JobDetails {
    stdoutPath: string;
    stderrPath: string;
    submitScript: string;
    workDir: string;
}

export interface RemoteFileInfo {
    path: string;
    type: string;
    size: number;
}

export interface SlurmAvailabilityStatus {
    available: boolean;
    mode: 'mock' | 'local' | 'ssh';
    message: string;
}

interface HistoryPathContext {
    jobName?: string;
    nodes?: string;
}

interface PathExpansionOptions {
    username?: string;
    remote?: boolean;
}

const UNAVAILABLE_PATH_VALUES = new Set(['', 'n/a', 'unknown', '(null)', 'null', 'none', '(none)']);

export function isUnavailableSlurmPath(value: string | undefined): boolean {
    if (value === undefined) {
        return true;
    }

    return UNAVAILABLE_PATH_VALUES.has(value.trim().toLowerCase());
}

export function normalizeSlurmPathValue(value: string | undefined): string {
    if (value === undefined) {
        return 'N/A';
    }

    let normalized = value.trim();
    if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'"))) {
        normalized = normalized.slice(1, -1);
    }

    normalized = normalized.replace(/\\([0-7]{3})/g, (_, octal: string) =>
        String.fromCharCode(parseInt(octal, 8))
    );

    return isUnavailableSlurmPath(normalized) ? 'N/A' : normalized;
}

export function normalizeOpenableFilePath(filePath: string, fallbackBaseDir?: string): string | undefined {
    const normalized = normalizeSlurmPathValue(filePath);
    if (normalized === 'N/A') {
        return undefined;
    }

    const homeExpanded = normalized === '~'
        ? os.homedir()
        : normalized.startsWith('~/')
            ? path.join(os.homedir(), normalized.slice(2))
            : normalized;

    if (path.isAbsolute(homeExpanded) || !fallbackBaseDir) {
        return homeExpanded;
    }

    return path.resolve(fallbackBaseDir, homeExpanded);
}

export function hasUnresolvedSlurmPathPlaceholders(filePath: string): boolean {
    return /(^|[^%])%[A-Za-z]/.test(filePath);
}

function shouldCacheOutputPath(filePath: string): boolean {
    return !isUnavailableSlurmPath(filePath) &&
        !filePath.includes('PENDING_NODE') &&
        !hasUnresolvedSlurmPathPlaceholders(filePath);
}

function shouldUseCachedOutputPaths(paths: { stdoutPath: string; stderrPath: string }): boolean {
    return shouldCacheOutputPath(paths.stdoutPath) || shouldCacheOutputPath(paths.stderrPath);
}

function sanitizeOutputPathsForCache(paths: { stdoutPath: string; stderrPath: string }): { stdoutPath: string; stderrPath: string } {
    return {
        stdoutPath: shouldCacheOutputPath(paths.stdoutPath) ? paths.stdoutPath : 'N/A',
        stderrPath: shouldCacheOutputPath(paths.stderrPath) ? paths.stderrPath : 'N/A',
    };
}

function readScontrolField(stdout: string, fieldName: string): string {
    const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fieldPattern = new RegExp(`(?:^|\\s)${escapedFieldName}=([\\s\\S]*?)(?=\\s+[A-Za-z][A-Za-z0-9_]*=|$)`);
    const match = stdout.match(fieldPattern);
    return normalizeSlurmPathValue(match?.[1]);
}

export function parseJobDetailsOutput(stdout: string): JobDetails & {
    gpuCount?: number;
    gpuType?: string;
    memory?: string;
    dependency?: string;
} {
    // Parse GPU count and type from various SLURM fields
    // Formats: TresPerNode=gres/gpu:h200:2, AllocTRES=...gres/gpu=2..., Gres=gpu:2
    let gpuCount: number | undefined;
    let gpuType: string | undefined;

    // Try TresPerNode first (e.g., "gres/gpu:h200:2" -> type=h200, count=2)
    const tresPerNodeMatch = stdout.match(/TresPerNode=gres\/gpu:([^:]+):(\d+)/);
    if (tresPerNodeMatch) {
        gpuType = tresPerNodeMatch[1].toUpperCase();
        gpuCount = parseInt(tresPerNodeMatch[2], 10);
    }

    // Fallback to AllocTRES for GPU type (e.g., "gres/gpu:h200=2")
    if (!gpuType) {
        const allocTresTypeMatch = stdout.match(/AllocTRES=.*gres\/gpu:([^=]+)=(\d+)/);
        if (allocTresTypeMatch) {
            gpuType = allocTresTypeMatch[1].toUpperCase();
            gpuCount = parseInt(allocTresTypeMatch[2], 10);
        }
    }

    // Fallback to AllocTRES for count only (e.g., "gres/gpu=2")
    if (!gpuCount) {
        const allocTresMatch = stdout.match(/AllocTRES=.*gres\/gpu=(\d+)/);
        if (allocTresMatch) {
            gpuCount = parseInt(allocTresMatch[1], 10);
        }
    }

    // Fallback to Gres field (e.g., "Gres=gpu:4" or "Gres=gpu:a100:2")
    if (!gpuCount) {
        const gresMatch = stdout.match(/Gres=([^\s]+)/);
        if (gresMatch && gresMatch[1] !== '(null)') {
            const gpuTypeCountMatch = gresMatch[1].match(/gpu:([^:]+):(\d+)/);
            if (gpuTypeCountMatch) {
                gpuType = gpuTypeCountMatch[1].toUpperCase();
                gpuCount = parseInt(gpuTypeCountMatch[2], 10);
            } else {
                const gpuCountMatch = gresMatch[1].match(/gpu:(\d+)/);
                if (gpuCountMatch) {
                    gpuCount = parseInt(gpuCountMatch[1], 10);
                }
            }
        }
    }

    // Parse memory from AllocTRES (e.g., "mem=500000M")
    let memory: string | undefined;
    const memMatch = stdout.match(/AllocTRES=.*mem=(\d+)([KMGT])?/);
    if (memMatch) {
        const value = parseInt(memMatch[1], 10);
        const unit = memMatch[2] || 'M';
        memory = unit === 'M' && value >= 1000
            ? `${Math.round(value / 1000)}G`
            : `${value}${unit}`;
    }

    const dependency = readScontrolField(stdout, 'Dependency');

    return {
        stdoutPath: readScontrolField(stdout, 'StdOut'),
        stderrPath: readScontrolField(stdout, 'StdErr'),
        submitScript: readScontrolField(stdout, 'Command'),
        workDir: readScontrolField(stdout, 'WorkDir'),
        gpuCount,
        gpuType,
        memory,
        dependency: dependency !== 'N/A' ? dependency : undefined,
    };
}

function cloneSlurmJob(job: SlurmJob): SlurmJob {
    return { ...job };
}

function createMockJobs(): SlurmJob[] {
    return [
        {
            jobId: '91001',
            name: 'train-transformer',
            state: 'R',
            time: '00:42:10',
            partition: 'h200',
            nodes: 'gpu-node[01]',
            stdoutPath: '/work/vision_lab/runs/train-transformer/logs/91001.out',
            stderrPath: '/work/vision_lab/runs/train-transformer/logs/91001.err',
            timeLimit: '02:00:00',
            startTime: '2026-04-28T09:00:00.000Z',
            workDir: '/work/vision_lab/runs/train-transformer',
            submitScript: '/work/vision_lab/slurm/train-transformer.sbatch',
            gpuCount: 2,
            gpuType: 'H200',
            memory: '128G',
        },
        {
            jobId: '91002',
            name: 'large-sweep',
            state: 'PD',
            time: '0:00',
            partition: 'a100-long',
            nodes: 'N/A',
            stdoutPath: 'N/A',
            stderrPath: 'N/A',
            timeLimit: '04:00:00',
            startTime: '2099-01-02T03:04:00.000Z',
            workDir: '/work/atlas_lab/sweeps/large-sweep',
            submitScript: '/work/atlas_lab/slurm/large-sweep.sbatch',
            gpuCount: 4,
            gpuType: 'A100',
            memory: '256G',
            pendingReason: 'Resources',
        },
        {
            jobId: '91003',
            name: 'dependent-eval',
            state: 'PD',
            time: '0:00',
            partition: 'h200',
            nodes: 'N/A',
            stdoutPath: 'N/A',
            stderrPath: 'N/A',
            timeLimit: '01:00:00',
            startTime: 'Unknown',
            workDir: '/work/vision_lab/evals/dependent-eval',
            submitScript: '/work/vision_lab/slurm/dependent-eval.sbatch',
            gpuCount: 1,
            gpuType: 'H200',
            memory: '64G',
            dependency: 'afterok:91001',
            pendingReason: 'Dependency',
        },
        {
            jobId: '91004_3',
            name: 'array-postprocess',
            state: 'PD',
            time: '0:00',
            partition: 'debug-gpu',
            nodes: 'N/A',
            stdoutPath: 'N/A',
            stderrPath: 'N/A',
            timeLimit: '00:30:00',
            startTime: '2099-01-02T04:00:00.000Z',
            workDir: '/work/render_lab/postprocess/array',
            submitScript: '/work/render_lab/slurm/array-postprocess.sbatch',
            gpuCount: 1,
            gpuType: 'A100',
            memory: '32G',
            pendingReason: 'Priority',
        },
        {
            jobId: '91005',
            name: 'cleanup',
            state: 'CG',
            time: '00:04:12',
            partition: 'cpu',
            nodes: 'cpu-node[02]',
            stdoutPath: '/work/data_lab/logs/cleanup-91005.out',
            stderrPath: '/work/data_lab/logs/cleanup-91005.err',
            timeLimit: '00:10:00',
            startTime: '2026-04-28T09:30:00.000Z',
            workDir: '/work/data_lab/maintenance/cleanup',
            submitScript: '/work/data_lab/slurm/cleanup.sbatch',
            memory: '8G',
        },
    ];
}

function createMockHistoryJobs(): HistoryJob[] {
    return [
        {
            jobId: '90990',
            name: 'finished-training',
            state: 'COMPLETED',
            exitCode: 0,
            startTime: '2026-04-27T10:00:00.000Z',
            endTime: '2026-04-27T11:32:00.000Z',
            elapsed: '01:32:00',
            partition: 'gpu',
            nodes: 'gpu-node[03]',
            cpus: '16',
            maxMemory: '72G',
            stdoutPath: '/work/vision_lab/runs/finished-training/logs/90990.out',
            stderrPath: '/work/vision_lab/runs/finished-training/logs/90990.err',
        },
        {
            jobId: '90991',
            name: 'failed-preprocess',
            state: 'FAILED',
            exitCode: 1,
            startTime: '2026-04-27T12:00:00.000Z',
            endTime: '2026-04-27T12:03:00.000Z',
            elapsed: '00:03:00',
            partition: 'cpu',
            nodes: 'cpu-node[01]',
            cpus: '4',
            maxMemory: '2G',
            stdoutPath: '/work/data_lab/logs/failed-preprocess-90991.out',
            stderrPath: '/work/data_lab/logs/failed-preprocess-90991.err',
        },
        {
            jobId: '90992',
            name: 'ablation-grid',
            state: 'TIMEOUT',
            exitCode: 0,
            startTime: '2026-04-26T18:00:00.000Z',
            endTime: '2026-04-27T06:00:00.000Z',
            elapsed: '12:00:00',
            partition: 'a100-long',
            nodes: 'gpu-node[08-09]',
            cpus: '32',
            maxMemory: '188G',
            stdoutPath: '/work/atlas_lab/runs/ablation-grid/logs/90992.out',
            stderrPath: '/work/atlas_lab/runs/ablation-grid/logs/90992.err',
        },
        {
            jobId: '90993',
            name: 'interactive-probe',
            state: 'CANCELLED',
            exitCode: 0,
            startTime: '2026-04-26T14:15:00.000Z',
            endTime: '2026-04-26T14:46:00.000Z',
            elapsed: '00:31:00',
            partition: 'debug-gpu',
            nodes: 'gpu-node[02]',
            cpus: '8',
            maxMemory: '24G',
            stdoutPath: '/work/proto_lab/logs/interactive-probe-90993.out',
            stderrPath: '/work/proto_lab/logs/interactive-probe-90993.err',
        },
    ];
}

export interface ClusterLeaderboardEntry {
    username: string;
    accounts: string[];
    gpuCount: number;
    gpuJobCount: number;
    gpuTypes: ClusterLeaderboardGpuType[];
}

export interface ClusterLeaderboardGpuType {
    type: string;
    count: number;
}

export interface ClusterAccountOverviewEntry {
    account: string;
    gpuCount: number;
    gpuJobCount: number;
    gpuTypes: ClusterLeaderboardGpuType[];
    users: ClusterAccountOverviewUser[];
}

export interface ClusterAccountOverviewUser {
    username: string;
    gpuCount: number;
    gpuJobCount: number;
}

export interface PartitionUsageEntry {
    partition: string;
    isDefault: boolean;
    totalNodes: number;
    allocatedNodes: number;
    idleNodes: number;
    otherNodes: number;
    totalGpus: number;
    availableGpus: number;
    allocatedGpus: number;
    idleGpus: number;
    runningJobs: number;
    pendingJobs: number;
    gpuTypes: ClusterLeaderboardGpuType[];
}

function normalizeSlurmAccount(account: string): string | undefined {
    const trimmed = account.trim();
    if (!trimmed || trimmed === '(null)' || trimmed === 'N/A') {
        return undefined;
    }
    return trimmed;
}

function parseGpuAllocations(gres: string): ClusterLeaderboardGpuType[] {
    const allocations: ClusterLeaderboardGpuType[] = [];
    const gpuPattern = /(?:^|[,\s/])gpu(?::([A-Za-z0-9_.-]+))?(?::|=)(\d+)/g;
    let match: RegExpExecArray | null;

    while ((match = gpuPattern.exec(gres)) !== null) {
        const count = parseInt(match[2], 10);
        if (count > 0) {
            allocations.push({
                type: match[1] || 'generic',
                count,
            });
        }
    }

    return allocations;
}

function formatGpuTypeEntries(gpuTypes: Map<string, number>): ClusterLeaderboardGpuType[] {
    return Array.from(gpuTypes.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export function parseClusterLeaderboardOutput(stdout: string): ClusterLeaderboardEntry[] {
    const lines = stdout.trim().split('\n').filter(line => line.trim());

    if (lines.length === 0) {
        return [];
    }

    const gpuJobCounts = new Map<string, number>();
    const gpuCounts = new Map<string, number>();
    const accountsByUser = new Map<string, Set<string>>();
    const gpuTypesByUser = new Map<string, Map<string, number>>();

    for (const line of lines) {
        const parts = line.split('|');
        const user = parts[0].trim();
        if (!user) {
            continue;
        }
        const hasAccountColumn = parts.length >= 3;
        const account = hasAccountColumn ? normalizeSlurmAccount(parts[1] || '') : undefined;
        const gres = (hasAccountColumn ? parts[2] : parts[1])?.trim() || '';
        const gpuAllocations = parseGpuAllocations(gres);

        if (gpuAllocations.length > 0) {
            const jobGpuCount = gpuAllocations.reduce((total, allocation) => total + allocation.count, 0);
            gpuJobCounts.set(user, (gpuJobCounts.get(user) || 0) + 1);
            gpuCounts.set(user, (gpuCounts.get(user) || 0) + jobGpuCount);

            if (!gpuTypesByUser.has(user)) {
                gpuTypesByUser.set(user, new Map<string, number>());
            }
            const userGpuTypes = gpuTypesByUser.get(user);
            for (const allocation of gpuAllocations) {
                if (userGpuTypes) {
                    userGpuTypes.set(allocation.type, (userGpuTypes.get(allocation.type) || 0) + allocation.count);
                }
            }

            if (account) {
                if (!accountsByUser.has(user)) {
                    accountsByUser.set(user, new Set<string>());
                }
                accountsByUser.get(user)?.add(account);
            }
        }
    }

    return Array.from(gpuCounts.keys()).map(username => ({
        username,
        accounts: Array.from(accountsByUser.get(username) || []).sort((a, b) => a.localeCompare(b)),
        gpuCount: gpuCounts.get(username) || 0,
        gpuJobCount: gpuJobCounts.get(username) || 0,
        gpuTypes: formatGpuTypeEntries(gpuTypesByUser.get(username) || new Map<string, number>()),
    }));
}

export function parseClusterAccountOverviewOutput(stdout: string): ClusterAccountOverviewEntry[] {
    const lines = stdout.trim().split('\n').filter(line => line.trim());

    if (lines.length === 0) {
        return [];
    }

    const gpuJobCounts = new Map<string, number>();
    const gpuCounts = new Map<string, number>();
    const gpuTypesByAccount = new Map<string, Map<string, number>>();
    const usersByAccount = new Map<string, Map<string, ClusterAccountOverviewUser>>();

    for (const line of lines) {
        const parts = line.split('|');
        const user = parts[0].trim();
        if (!user) {
            continue;
        }

        const hasAccountColumn = parts.length >= 3;
        const account = (hasAccountColumn ? normalizeSlurmAccount(parts[1] || '') : undefined) ?? 'unknown';
        const gres = (hasAccountColumn ? parts[2] : parts[1])?.trim() || '';
        const gpuAllocations = parseGpuAllocations(gres);

        if (gpuAllocations.length === 0) {
            continue;
        }

        const jobGpuCount = gpuAllocations.reduce((total, allocation) => total + allocation.count, 0);
        gpuJobCounts.set(account, (gpuJobCounts.get(account) || 0) + 1);
        gpuCounts.set(account, (gpuCounts.get(account) || 0) + jobGpuCount);

        if (!gpuTypesByAccount.has(account)) {
            gpuTypesByAccount.set(account, new Map<string, number>());
        }
        const accountGpuTypes = gpuTypesByAccount.get(account);
        for (const allocation of gpuAllocations) {
            if (accountGpuTypes) {
                accountGpuTypes.set(allocation.type, (accountGpuTypes.get(allocation.type) || 0) + allocation.count);
            }
        }

        if (!usersByAccount.has(account)) {
            usersByAccount.set(account, new Map<string, ClusterAccountOverviewUser>());
        }
        const accountUsers = usersByAccount.get(account);
        if (accountUsers) {
            const userEntry = accountUsers.get(user) ?? { username: user, gpuCount: 0, gpuJobCount: 0 };
            userEntry.gpuCount += jobGpuCount;
            userEntry.gpuJobCount += 1;
            accountUsers.set(user, userEntry);
        }
    }

    return Array.from(gpuCounts.keys()).map(account => ({
        account,
        gpuCount: gpuCounts.get(account) || 0,
        gpuJobCount: gpuJobCounts.get(account) || 0,
        gpuTypes: formatGpuTypeEntries(gpuTypesByAccount.get(account) || new Map<string, number>()),
        users: Array.from(usersByAccount.get(account)?.values() || [])
            .sort((a, b) => b.gpuCount - a.gpuCount || b.gpuJobCount - a.gpuJobCount || a.username.localeCompare(b.username)),
    }));
}

export function parsePartitionUsageOutput(sinfoStdout: string, squeueStdout: string): PartitionUsageEntry[] {
    const entriesByPartition = new Map<string, PartitionUsageEntry>();
    const gpuTypesByPartition = new Map<string, Map<string, number>>();

    const getEntry = (partition: string, isDefault: boolean = false): PartitionUsageEntry => {
        const existing = entriesByPartition.get(partition);
        if (existing) {
            existing.isDefault = existing.isDefault || isDefault;
            return existing;
        }

        const entry: PartitionUsageEntry = {
            partition,
            isDefault,
            totalNodes: 0,
            allocatedNodes: 0,
            idleNodes: 0,
            otherNodes: 0,
            totalGpus: 0,
            availableGpus: 0,
            allocatedGpus: 0,
            idleGpus: 0,
            runningJobs: 0,
            pendingJobs: 0,
            gpuTypes: [],
        };
        entriesByPartition.set(partition, entry);
        gpuTypesByPartition.set(partition, new Map<string, number>());
        return entry;
    };

    const sinfoLines = sinfoStdout.trim().split('\n').filter(line => line.trim());
    for (const line of sinfoLines) {
        const parts = line.split('|');
        if (parts.length < 4) {
            continue;
        }

        const partitionInfo = normalizePartitionName(parts[0]);
        if (!partitionInfo.partition) {
            continue;
        }

        const entry = getEntry(partitionInfo.partition, partitionInfo.isDefault);
        const nodeCount = parseInt(parts[1].trim(), 10) || 0;
        const nodeStates = parseSinfoNodeStateSummary(parts[2], nodeCount);
        entry.allocatedNodes += nodeStates.allocatedNodes;
        entry.idleNodes += nodeStates.idleNodes;
        entry.otherNodes += nodeStates.otherNodes;
        entry.totalNodes += nodeStates.totalNodes;

        const gpuAllocations = parseGpuAllocations(parts.slice(3).join('|'));
        const partitionGpuTypes = gpuTypesByPartition.get(entry.partition);
        for (const allocation of gpuAllocations) {
            const totalTypeGpus = allocation.count * nodeCount;
            const availableTypeGpus = allocation.count * (nodeStates.allocatedNodes + nodeStates.idleNodes);
            entry.totalGpus += totalTypeGpus;
            entry.availableGpus += availableTypeGpus;
            partitionGpuTypes?.set(allocation.type, (partitionGpuTypes.get(allocation.type) || 0) + totalTypeGpus);
        }
    }

    const squeueLines = squeueStdout.trim().split('\n').filter(line => line.trim());
    for (const line of squeueLines) {
        const parts = line.split('|');
        if (parts.length < 2) {
            continue;
        }

        const state = parts[1].trim().toUpperCase();
        const gres = parts.slice(2).join('|');
        const partitionInfos = parsePartitionList(parts[0]);
        if (partitionInfos.length === 0) {
            continue;
        }

        if (state === 'R' || state === 'RUNNING') {
            const partitionInfo = partitionInfos[0];
            const entry = getEntry(partitionInfo.partition, partitionInfo.isDefault);
            entry.runningJobs += 1;
            const gpuAllocations = parseGpuAllocations(gres);
            entry.allocatedGpus += gpuAllocations.reduce((total, allocation) => total + allocation.count, 0);
        } else if (state === 'PD' || state === 'PENDING') {
            for (const partitionInfo of partitionInfos) {
                const entry = getEntry(partitionInfo.partition, partitionInfo.isDefault);
                entry.pendingJobs += 1;
            }
        }
    }

    for (const entry of entriesByPartition.values()) {
        entry.idleGpus = Math.max(0, entry.availableGpus - entry.allocatedGpus);
        entry.gpuTypes = formatGpuTypeEntries(gpuTypesByPartition.get(entry.partition) || new Map<string, number>());
    }

    return Array.from(entriesByPartition.values())
        .filter(entry => entry.totalGpus > 0);
}

function normalizePartitionName(rawPartition: string): { partition: string; isDefault: boolean } {
    const trimmed = rawPartition.trim();
    const isDefault = trimmed.endsWith('*');
    return {
        partition: isDefault ? trimmed.slice(0, -1) : trimmed,
        isDefault,
    };
}

function parsePartitionList(rawPartitions: string): { partition: string; isDefault: boolean }[] {
    return rawPartitions
        .split(',')
        .map(normalizePartitionName)
        .filter(partitionInfo => partitionInfo.partition.length > 0);
}

function parseSinfoNodeStateSummary(
    nodeStateSummary: string,
    fallbackTotalNodes: number,
): { allocatedNodes: number; idleNodes: number; otherNodes: number; totalNodes: number } {
    const parts = nodeStateSummary.trim().split('/').map(part => parseInt(part, 10));
    if (parts.length === 4 && parts.every(part => Number.isFinite(part))) {
        return {
            allocatedNodes: parts[0],
            idleNodes: parts[1],
            otherNodes: parts[2],
            totalNodes: parts[3],
        };
    }

    return {
        allocatedNodes: 0,
        idleNodes: 0,
        otherNodes: fallbackTotalNodes,
        totalNodes: fallbackTotalNodes,
    };
}

function createMockLeaderboardEntries(): ClusterLeaderboardEntry[] {
    return [
        {
            username: 'nova42',
            accounts: ['atlas_lab'],
            gpuCount: 24,
            gpuJobCount: 3,
            gpuTypes: [
                { type: 'a100', count: 16 },
                { type: 'h200', count: 8 },
            ],
        },
        {
            username: 'pixelwave',
            accounts: ['vision_lab'],
            gpuCount: 18,
            gpuJobCount: 3,
            gpuTypes: [
                { type: 'h200', count: 10 },
                { type: 'a100', count: 8 },
            ],
        },
        {
            username: 'quartz',
            accounts: ['nebula_lab'],
            gpuCount: 16,
            gpuJobCount: 2,
            gpuTypes: [{ type: 'a100', count: 16 }],
        },
        {
            username: 'zephyr',
            accounts: ['robotics_lab'],
            gpuCount: 8,
            gpuJobCount: 2,
            gpuTypes: [{ type: 'l40s', count: 8 }],
        },
        {
            username: 'solis',
            accounts: ['climate_lab'],
            gpuCount: 8,
            gpuJobCount: 1,
            gpuTypes: [{ type: 'h200', count: 8 }],
        },
        {
            username: 'rune',
            accounts: ['data_lab'],
            gpuCount: 6,
            gpuJobCount: 6,
            gpuTypes: [{ type: 'rtx6000', count: 6 }],
        },
    ];
}

function createMockAccountOverviewEntries(): ClusterAccountOverviewEntry[] {
    const rows = [
        'nova42|atlas_lab|gpu:a100:8',
        'nova42|atlas_lab|gpu:a100:8',
        'nova42|atlas_lab|gpu:h200:8',
        'pixelwave|vision_lab|gpu:h200:8',
        'pixelwave|vision_lab|gpu:a100:8',
        'pixelwave|vision_lab|gpu:h200:2',
        'quartz|nebula_lab|gpu:a100:8',
        'quartz|nebula_lab|gpu:a100:8',
        'zephyr|robotics_lab|gpu:l40s:4',
        'zephyr|robotics_lab|gpu:l40s:4',
        'solis|climate_lab|gpu:h200:8',
        'rune|data_lab|gpu:rtx6000:1',
        'rune|data_lab|gpu:rtx6000:1',
        'rune|data_lab|gpu:rtx6000:1',
        'rune|data_lab|gpu:rtx6000:1',
        'rune|data_lab|gpu:rtx6000:1',
        'rune|data_lab|gpu:rtx6000:1',
    ];

    return parseClusterAccountOverviewOutput(rows.join('\n'));
}

function createMockPartitionUsageEntries(): PartitionUsageEntry[] {
    return parsePartitionUsageOutput([
        'h200*|6|2/3/1/6|gpu:h200:4',
        'a100-long|8|4/3/1/8|gpu:a100:4',
        'a100-short|6|1/5/0/6|gpu:a100:4',
        'l40s|5|1/4/0/5|gpu:l40s:4',
        'debug-gpu|2|0/2/0/2|gpu:a100:1',
        'cpu|8|1/7/0/8|(null)',
    ].join('\n'), [
        'h200|R|gpu:h200:2',
        'h200|R|gpu:h200:4',
        'h200|PD|gpu:h200:1',
        'a100-long|R|gpu:a100:8',
        'a100-long|R|gpu:a100:8',
        'a100-long|PD|gpu:a100:4',
        'a100-short,h200|PD|gpu:a100:2',
        'a100-short|R|gpu:a100:4',
        'a100-short|PD|gpu:a100:4',
        'l40s|R|gpu:l40s:4',
        'l40s|PD|gpu:l40s:2',
        'debug-gpu|PD|gpu:a100:1',
        'cpu|R|(null)',
        'cpu|PD|(null)',
    ].join('\n'));
}

function slurmStateNameToCode(state: string): string {
    const states: Record<string, string> = {
        PENDING: 'PD',
        RUNNING: 'R',
        COMPLETING: 'CG',
        COMPLETED: 'CD',
        FAILED: 'F',
        TIMEOUT: 'TO',
        CANCELLED: 'CA',
        NODE_FAIL: 'NF',
        PREEMPTED: 'PR',
        SUSPENDED: 'S',
    };

    return states[state] || state;
}

function normalizeScancelJobId(jobId: string): string {
    // squeue can render array throttles like 123_[0-100%5], but scancel expects 123_[0-100].
    return jobId.replace(/%\d+(?=\])/, '');
}

/**
 * Service for interacting with SLURM cluster
 */
export class SlurmService {
    private pathCache?: JobPathCache;
    private scriptCache?: SubmitScriptCache;
    private executor: SlurmExecutor;
    private mockModeProvider: SlurmMockModeProvider;
    private mockJobs?: SlurmJob[];
    private currentUsername?: string;

    constructor(
        pathCache?: JobPathCache,
        scriptCache?: SubmitScriptCache,
        executor: SlurmExecutor = new LocalSlurmExecutor(),
        mockModeProvider: SlurmMockModeProvider = () => false,
    ) {
        this.pathCache = pathCache;
        this.scriptCache = scriptCache;
        this.executor = executor;
        this.mockModeProvider = mockModeProvider;
    }

    setExecutor(executor: SlurmExecutor): void {
        this.executor = executor;
        this.currentUsername = undefined;
    }

    isRemoteMode(): boolean {
        return !this.isMockMode() && this.executor.kind === 'ssh';
    }

    getConnectionKind(): 'local' | 'ssh' {
        return this.executor.kind;
    }

    getConnectionKey(): string {
        return this.executor.connectionKey;
    }

    private isMockMode(): boolean {
        try {
            return this.mockModeProvider();
        } catch {
            return false;
        }
    }

    private getMutableMockJobs(): SlurmJob[] {
        if (!this.mockJobs) {
            this.mockJobs = createMockJobs();
        }

        return this.mockJobs;
    }

    private getMockJobsSnapshot(): SlurmJob[] {
        return this.getMutableMockJobs().map(cloneSlurmJob);
    }

    private async getCurrentUsername(): Promise<string> {
        if (this.currentUsername) {
            return this.currentUsername;
        }

        try {
            const { stdout } = await this.executor.run({ command: 'id', args: ['-un'] });
            const username = stdout.trim();
            if (username) {
                this.currentUsername = username;
                return username;
            }
        } catch (error) {
            if (this.executor.kind === 'ssh') {
                throw error;
            }
        }

        this.currentUsername = getLocalUsernameFallback();
        return this.currentUsername;
    }

    private getPathCacheKey(jobId: string): string {
        return this.executor.kind === 'ssh'
            ? `${this.executor.connectionKey}:${jobId}`
            : jobId;
    }

    private async expandJobPath(pathValue: string, jobId: string, jobName: string, nodes: string, workDir?: string): Promise<string> {
        return expandPathPlaceholders(pathValue, jobId, jobName, nodes, workDir, {
            username: await this.getCurrentUsername(),
            remote: this.isRemoteMode(),
        });
    }

    /**
     * Fetch current user's jobs from SLURM
     * Uses squeue command with custom format for parsing
     */
    async getJobs(): Promise<SlurmJob[]> {
        if (this.isMockMode()) {
            return this.getMockJobsSnapshot();
        }

        try {
            const username = await this.getCurrentUsername();
            // Format: JobID|Name|State|Time|Partition|NodeList|TimeLimit|StartTime|Reason
            const { stdout } = await this.executor.run({
                command: 'squeue',
                args: ['-u', username, '--noheader', '--format=%i|%j|%t|%M|%P|%N|%l|%S|%r'],
            });

            const jobs: SlurmJob[] = [];
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                const parts = line.split('|');
                if (parts.length >= 8) {
                    const jobId = parts[0].trim();
                    const state = parts[2].trim();
                    const job: SlurmJob = {
                        jobId: jobId,
                        name: parts[1].trim(),
                        state,
                        time: parts[3].trim(),
                        partition: parts[4].trim(),
                        nodes: parts[5].trim() || 'N/A',
                        timeLimit: parts[6].trim() || 'N/A',
                        startTime: parts[7].trim() || 'N/A',
                        // These will be fetched from scontrol
                        stdoutPath: 'N/A',
                        stderrPath: 'N/A',
                        submitScript: 'N/A',
                        workDir: 'N/A',
                    };

                    if (state === 'PD') {
                        job.pendingReason = normalizePendingReason(parts[8]);
                    }

                    jobs.push(job);
                }
            }

            // Fetch detailed info (stdout, stderr, command) from scontrol for all jobs in parallel
            await Promise.all(jobs.map(async (job) => {
                const details = await this.getJobDetails(job.jobId);
                // Expand any remaining placeholders in paths
                job.stdoutPath = await this.expandJobPath(details.stdoutPath, job.jobId, job.name, job.nodes, details.workDir);
                job.stderrPath = await this.expandJobPath(details.stderrPath, job.jobId, job.name, job.nodes, details.workDir);
                job.submitScript = await this.expandJobPath(details.submitScript, job.jobId, job.name, job.nodes, details.workDir);
                job.workDir = details.workDir;
                job.gpuCount = details.gpuCount;
                job.gpuType = details.gpuType;
                job.memory = details.memory;
                job.dependency = details.dependency;

                // Cache the paths for later use in history
                if (this.pathCache && shouldUseCachedOutputPaths(job)) {
                    const cacheablePaths = sanitizeOutputPathsForCache(job);
                    await this.pathCache.set(this.getPathCacheKey(job.jobId), cacheablePaths.stdoutPath, cacheablePaths.stderrPath);
                }

                // Cache the submit script if not already cached
                if (!this.isRemoteMode() && this.scriptCache && job.submitScript && job.submitScript !== 'N/A') {
                    job.cachedSubmitScript = await this.scriptCache.cacheScript(job.jobId, job.submitScript);
                }
            }));

            // Fetch GPU info once (for running jobs on this node)
            const gpuInfo = await this.getGpuInfo();
            if (gpuInfo) {
                // Apply GPU info to running jobs
                for (const job of jobs) {
                    if (job.state === 'R') {
                        job.gpuName = gpuInfo.gpuName;
                        job.gpuMemory = gpuInfo.gpuMemory;
                    }
                }
            }

            return jobs;
        } catch (error) {
            // If squeue is not available or fails, return empty array
            // This allows the extension to work gracefully when not on a cluster
            console.error('Failed to fetch SLURM jobs:', error);
            return [];
        }
    }

    /**
     * Get detailed job info from scontrol (stdout, stderr, command paths)
     */
    async getJobDetails(jobId: string): Promise<JobDetails & { gpuCount?: number; gpuType?: string; memory?: string; dependency?: string }> {
        try {
            validateJobId(jobId);
            const { stdout } = await this.executor.run({
                command: 'scontrol',
                args: ['show', 'job', jobId],
            });
            return parseJobDetailsOutput(stdout);
        } catch {
            return {
                stdoutPath: 'N/A',
                stderrPath: 'N/A',
                submitScript: 'N/A',
                workDir: 'N/A',
            };
        }
    }

    /**
     * Check if SLURM is available on this system
     */
    async isAvailable(): Promise<boolean> {
        return (await this.getAvailabilityStatus()).available;
    }

    async getAvailabilityStatus(): Promise<SlurmAvailabilityStatus> {
        if (this.isMockMode()) {
            return {
                available: true,
                mode: 'mock',
                message: 'Mock Slurm data is enabled.',
            };
        }

        try {
            await this.executor.run({ command: 'squeue', args: ['--version'] });
            const target = this.executor.kind === 'ssh'
                ? this.executor.connectionKey.replace(/^ssh:/, '')
                : 'local system';
            return {
                available: true,
                mode: this.executor.kind,
                message: `SLURM is available on ${target}.`,
            };
        } catch (error) {
            return {
                available: false,
                mode: this.executor.kind,
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async testConnection(): Promise<{ success: boolean; message: string }> {
        if (this.isMockMode()) {
            return { success: true, message: 'Mock Slurm data is enabled.' };
        }

        try {
            const username = await this.getCurrentUsername();
            const { stdout } = await this.executor.run({ command: 'squeue', args: ['--version'] });
            const version = stdout.trim().split('\n')[0] || 'squeue is available';
            const target = this.executor.kind === 'ssh' ? this.executor.connectionKey.replace(/^ssh:/, '') : 'local system';
            return {
                success: true,
                message: `Connected to ${target} as ${username}. ${version}`,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                message: `SLURM connection failed: ${errorMessage}`,
            };
        }
    }

    async getRemoteFileInfo(filePath: string): Promise<RemoteFileInfo> {
        if (!this.isRemoteMode()) {
            throw new Error('Remote file access is only available in SSH connection mode.');
        }

        validateRemoteFilePath(filePath);
        const { stdout } = await this.executor.run({
            command: 'stat',
            args: ['-Lc', '%F|%s', filePath],
        });

        const firstLine = stdout.trim().split('\n')[0] || '';
        const separatorIndex = firstLine.lastIndexOf('|');
        if (separatorIndex < 0) {
            throw new Error(`Could not read remote file metadata for ${filePath}`);
        }

        const type = firstLine.slice(0, separatorIndex);
        const size = Number(firstLine.slice(separatorIndex + 1));
        if (!Number.isFinite(size) || size < 0) {
            throw new Error(`Could not read remote file size for ${filePath}`);
        }

        return { path: filePath, type, size };
    }

    async readRemoteFile(filePath: string, maxBytes: number): Promise<string> {
        const info = await this.getRemoteFileInfo(filePath);
        if (!/regular.*file/i.test(info.type)) {
            throw new Error(`Remote path is not a regular file: ${filePath}`);
        }
        if (info.size > maxBytes) {
            throw new Error(`Remote file is too large to open (${info.size} bytes, limit ${maxBytes} bytes).`);
        }

        const { stdout } = await this.executor.run({
            command: 'cat',
            args: [filePath],
            maxBuffer: Math.max(maxBytes + 1024, 1024),
        });
        return stdout;
    }

    /**
     * Get GPU information using nvidia-smi
     * @returns Object with GPU name and memory, or null if unavailable
     */
    async getGpuInfo(): Promise<{ gpuName: string; gpuMemory: string } | null> {
        try {
            // Run both nvidia-smi commands in parallel
            const [nameResult, memoryResult] = await Promise.all([
                this.executor.run({ command: 'nvidia-smi', args: ['--query-gpu=name', '--format=csv,noheader'] }),
                this.executor.run({ command: 'nvidia-smi', args: ['--query-gpu=memory.total', '--format=csv,noheader'] }),
            ]);

            const gpuName = nameResult.stdout.trim().split('\n')[0] || 'Unknown';
            const gpuMemory = memoryResult.stdout.trim().split('\n')[0] || 'Unknown';

            return { gpuName, gpuMemory };
        } catch {
            // nvidia-smi not available or failed
            return null;
        }
    }

    /**
     * Get the users with the most running jobs and most GPUs on the cluster
     * @returns Object with top job hog and top GPU hog, or null if unavailable
     */
    async getClusterHogs(): Promise<{
        topJobHog: { username: string; jobCount: number } | null;
        topGpuHog: { username: string; gpuCount: number } | null;
    }> {
        if (this.isMockMode()) {
            return {
                topJobHog: { username: 'nova42', jobCount: 8 },
                topGpuHog: { username: 'nova42', gpuCount: 24 },
            };
        }

        try {
            // Get all running jobs with usernames and GRES (GPU resources)
            // %u = username, %b = GRES (e.g., "gpu:4", "gpu:a100:2", "(null)")
            const { stdout } = await this.executor.run({
                command: 'squeue',
                args: ['--noheader', '--state=R', '--format=%u|%b'],
            });

            const lines = stdout.trim().split('\n').filter(l => l.trim());

            if (lines.length === 0) {
                return { topJobHog: null, topGpuHog: null };
            }

            // Count jobs and GPUs per user
            const jobCounts = new Map<string, number>();
            const gpuCounts = new Map<string, number>();

            for (const line of lines) {
                const parts = line.split('|');
                const user = parts[0].trim();
                const gres = parts[1]?.trim() || '';

                // Count jobs
                jobCounts.set(user, (jobCounts.get(user) || 0) + 1);

                // Parse GPU count from GRES field
                // Formats: "gpu:4", "gpu:a100:2", "gpu:h200:1", "(null)", "N/A", ""
                if (gres && gres !== '(null)' && gres !== 'N/A') {
                    const gpuMatch = gres.match(/gpu(?::[^:]+)?:(\d+)/);
                    if (gpuMatch) {
                        const gpus = parseInt(gpuMatch[1], 10);
                        gpuCounts.set(user, (gpuCounts.get(user) || 0) + gpus);
                    }
                }
            }

            // Find the user with most jobs
            let topJobUser = '';
            let maxJobs = 0;
            jobCounts.forEach((count, user) => {
                if (count > maxJobs) {
                    maxJobs = count;
                    topJobUser = user;
                }
            });

            // Find the user with most GPUs
            let topGpuUser = '';
            let maxGpus = 0;
            gpuCounts.forEach((count, user) => {
                if (count > maxGpus) {
                    maxGpus = count;
                    topGpuUser = user;
                }
            });

            return {
                topJobHog: maxJobs > 0 ? { username: topJobUser, jobCount: maxJobs } : null,
                topGpuHog: maxGpus > 0 ? { username: topGpuUser, gpuCount: maxGpus } : null,
            };
        } catch (error) {
            console.error('Failed to get cluster hogs:', error);
            return { topJobHog: null, topGpuHog: null };
        }
    }

    /**
     * Get a full leaderboard of users ranked by GPU allocations.
     * @returns Array of { username, accounts, gpuCount, gpuJobCount, gpuTypes }
     */
    async getClusterLeaderboard(): Promise<ClusterLeaderboardEntry[]> {
        if (this.isMockMode()) {
            return createMockLeaderboardEntries();
        }

        try {
            const { stdout } = await this.executor.run({
                command: 'squeue',
                args: ['--noheader', '--state=R', '--format=%u|%a|%b'],
            });

            return parseClusterLeaderboardOutput(stdout);
        } catch (error) {
            console.error('Failed to get cluster leaderboard:', error);
            return [];
        }
    }

    /**
     * Get a cluster overview of running GPU allocations grouped by Slurm account.
     * @returns Array of { account, gpuCount, gpuJobCount, gpuTypes, users }
     */
    async getClusterAccountOverview(): Promise<ClusterAccountOverviewEntry[]> {
        if (this.isMockMode()) {
            return createMockAccountOverviewEntries();
        }

        try {
            const { stdout } = await this.executor.run({
                command: 'squeue',
                args: ['--noheader', '--state=R', '--format=%u|%a|%b'],
            });

            return parseClusterAccountOverviewOutput(stdout);
        } catch (error) {
            console.error('Failed to get cluster account overview:', error);
            return [];
        }
    }

    /**
     * Get partition usage across the cluster.
     * Combines sinfo capacity/node state data with squeue job pressure.
     */
    async getPartitionUsage(): Promise<PartitionUsageEntry[]> {
        if (this.isMockMode()) {
            return createMockPartitionUsageEntries();
        }

        try {
            const { stdout: sinfoStdout } = await this.executor.run({
                command: 'sinfo',
                args: ['--noheader', '--format=%P|%D|%F|%G'],
            });

            let squeueStdout = '';
            try {
                const squeueResult = await this.executor.run({
                    command: 'squeue',
                    args: ['--noheader', '--format=%P|%t|%b'],
                });
                squeueStdout = squeueResult.stdout;
            } catch {
                // Capacity information is still useful when queue pressure cannot be fetched.
            }

            return parsePartitionUsageOutput(sinfoStdout, squeueStdout);
        } catch (error) {
            console.error('Failed to get partition usage:', error);
            return [];
        }
    }

    /**
     * Get real-time stats for a SLURM partition
     * @param partition The partition name
     * @returns Partition stats or null if unavailable
     */
    async getPartitionStats(partition: string): Promise<{
        totalGpus: number;
        allocatedGpus: number;
        idleGpus: number;
        runningJobs: number;
        pendingJobs: number;
        nodesUp: number;
        nodesTotal: number;
        nodeStates: string;
    } | null> {
        if (this.isMockMode()) {
            const entry = createMockPartitionUsageEntries().find(candidate => candidate.partition === partition);
            const nodesUp = entry ? entry.allocatedNodes + entry.idleNodes : 0;

            return {
                totalGpus: entry?.availableGpus ?? 0,
                allocatedGpus: entry?.allocatedGpus ?? 0,
                idleGpus: entry?.idleGpus ?? 0,
                runningJobs: entry?.runningJobs ?? 0,
                pendingJobs: entry?.pendingJobs ?? this.getMutableMockJobs().filter(job => job.partition === partition && job.state === 'PD').length,
                nodesUp,
                nodesTotal: entry?.totalNodes ?? 0,
                nodeStates: entry ? `${nodesUp}/${entry.totalNodes}` : '0/0',
            };
        }

        try {
            validatePartitionName(partition);
            const [sinfoResult, squeueResult] = await Promise.all([
                this.executor.run({
                    command: 'sinfo',
                    args: ['-p', partition, '--noheader', '--format=%P|%D|%F|%G'],
                }),
                this.executor.run({
                    command: 'squeue',
                    args: ['-p', partition, '--noheader', '--format=%P|%t|%b'],
                }).catch(() => ({ stdout: '', stderr: '' })),
            ]);

            const entry = parsePartitionUsageOutput(sinfoResult.stdout, squeueResult.stdout)
                .find(candidate => candidate.partition === partition);

            if (!entry) {
                return null;
            }

            const nodesUp = entry.allocatedNodes + entry.idleNodes;

            return {
                totalGpus: entry.availableGpus,
                allocatedGpus: entry.allocatedGpus,
                idleGpus: entry.idleGpus,
                runningJobs: entry.runningJobs,
                pendingJobs: entry.pendingJobs,
                nodesUp,
                nodesTotal: entry.totalNodes,
                nodeStates: `${nodesUp}/${entry.totalNodes}`,
            };
        } catch (error) {
            console.error(`Failed to get partition stats for ${partition}:`, error);
            return null;
        }
    }

    /**
     * Cancel a SLURM job using scancel
     * @param jobId The job ID to cancel
     * @returns Object with success status and optional error message
     */
    async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
        const cleanId = normalizeScancelJobId(jobId);

        if (this.isMockMode()) {
            this.mockJobs = this.getMutableMockJobs().filter(job =>
                job.jobId !== cleanId && !job.jobId.startsWith(`${cleanId}_`)
            );
            return { success: true, message: `Job ${jobId} cancelled successfully` };
        }

        try {
            // Clean up job ID for scancel compatibility:
            // squeue may report array IDs with throttle notation (e.g., 12345_[0-100%5])
            // which scancel does not accept — strip the %N part
            validateJobId(cleanId);
            await this.executor.run({ command: 'scancel', args: [cleanId] });
            return { success: true, message: `Job ${jobId} cancelled successfully` };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to cancel job ${jobId}:`, error);
            return { success: false, message: `Failed to cancel job ${jobId}: ${errorMessage}` };
        }
    }

    /**
     * Cancel a SLURM job filtering by state (e.g., only pending jobs)
     * @param jobId The job ID to cancel
     * @param state The job state to filter by (e.g., 'PENDING')
     * @returns Object with success status and optional error message
     */
    async cancelJobByState(jobId: string, state: string): Promise<{ success: boolean; message: string }> {
        if (this.isMockMode()) {
            const stateCode = slurmStateNameToCode(state);
            this.mockJobs = this.getMutableMockJobs().filter(job => {
                const isTargetJob = job.jobId === jobId || job.jobId.startsWith(`${jobId}_`);
                return !(isTargetJob && job.state === stateCode);
            });
            return { success: true, message: `${state} jobs in ${jobId} cancelled successfully` };
        }

        try {
            validateJobId(jobId);
            validateJobState(state);
            await this.executor.run({ command: 'scancel', args: [`--state=${state}`, normalizeScancelJobId(jobId)] });
            return { success: true, message: `${state} jobs in ${jobId} cancelled successfully` };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to cancel ${state} jobs in ${jobId}:`, error);
            return { success: false, message: `Failed to cancel ${state} jobs in ${jobId}: ${errorMessage}` };
        }
    }

    /**
     * Cancel all SLURM jobs for the current user
     * @returns Object with success status and message
     */
    async cancelAllJobs(): Promise<{ success: boolean; message: string }> {
        if (this.isMockMode()) {
            this.mockJobs = [];
            return { success: true, message: 'All jobs cancelled successfully' };
        }

        try {
            const username = await this.getCurrentUsername();
            await this.executor.run({ command: 'scancel', args: ['-u', username] });
            return { success: true, message: 'All jobs cancelled successfully' };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to cancel all jobs:', error);
            return { success: false, message: `Failed to cancel all jobs: ${errorMessage}` };
        }
    }

    /**
     * Cancel all pending SLURM jobs for the current user
     * @returns Object with success status and message
     */
    async cancelAllPendingJobs(): Promise<{ success: boolean; message: string }> {
        if (this.isMockMode()) {
            this.mockJobs = this.getMutableMockJobs().filter(job => job.state !== 'PD');
            return { success: true, message: 'All pending jobs cancelled successfully' };
        }

        try {
            const username = await this.getCurrentUsername();
            await this.executor.run({ command: 'scancel', args: ['--state=PENDING', '-u', username] });
            return { success: true, message: 'All pending jobs cancelled successfully' };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Failed to cancel pending jobs:', error);
            return { success: false, message: `Failed to cancel pending jobs: ${errorMessage}` };
        }
    }

    /**
     * Get job array information from SLURM
     * @param jobId The base job ID (without array index)
     * @returns Object with min/max array indices, or null if not a job array or not found
     */
    async getJobArrayInfo(jobId: string): Promise<{ minIndex: number; maxIndex: number } | null> {
        if (this.isMockMode()) {
            const indices = this.getMutableMockJobs()
                .map(job => job.jobId.match(new RegExp(`^${jobId}_(\\d+)$`))?.[1])
                .filter((index): index is string => index !== undefined)
                .map(index => parseInt(index, 10));

            if (indices.length > 0) {
                return {
                    minIndex: Math.min(...indices),
                    maxIndex: Math.max(...indices),
                };
            }

            return null;
        }

        try {
            validateJobId(jobId);
            const { stdout } = await this.executor.run({
                command: 'scontrol',
                args: ['show', 'job', jobId],
            });

            // Parse the full ArrayTaskId value
            // Possible formats: "0-99", "0-99%10", "0,2,4,6-10", "1,3,5", "0-10:2", etc.
            const arrayFieldMatch = stdout.match(/ArrayTaskId=([^\s]+)/);
            if (!arrayFieldMatch) {
                return null;
            }

            // Strip throttle suffix (e.g., "%10") if present
            const rawValue = arrayFieldMatch[1].replace(/%\d+$/, '');

            let globalMin = Infinity;
            let globalMax = -Infinity;

            // Split by comma and process each component
            const components = rawValue.split(',');
            for (const component of components) {
                // Match range with optional step: "0-10" or "0-10:2"
                const rangeMatch = component.match(/^(\d+)-(\d+)(?::(\d+))?$/);
                if (rangeMatch) {
                    const start = parseInt(rangeMatch[1], 10);
                    const end = parseInt(rangeMatch[2], 10);
                    globalMin = Math.min(globalMin, start);
                    globalMax = Math.max(globalMax, end);
                } else {
                    // Single index: "5"
                    const index = parseInt(component, 10);
                    if (!isNaN(index)) {
                        globalMin = Math.min(globalMin, index);
                        globalMax = Math.max(globalMax, index);
                    }
                }
            }

            if (globalMin !== Infinity && globalMax !== -Infinity) {
                return { minIndex: globalMin, maxIndex: globalMax };
            }

            return null;
        } catch {
            return null;
        }
    }

    /**
     * Submit a SLURM job using sbatch
     * @param scriptPath Path to the submit script
     * @param workDir Optional working directory (defaults to script's parent directory)
     * @returns Object with success status, job ID (if successful), and message
     */
    async submitJob(scriptPath: string, workDir?: string): Promise<{ success: boolean; jobId?: string; message: string }> {
        if (this.isMockMode()) {
            const jobId = String(92000 + this.getMutableMockJobs().length + 1);
            this.getMutableMockJobs().push({
                jobId,
                name: require('path').basename(scriptPath),
                state: 'PD',
                time: '0:00',
                partition: 'mock',
                nodes: 'N/A',
                stdoutPath: 'N/A',
                stderrPath: 'N/A',
                timeLimit: '01:00:00',
                startTime: 'Unknown',
                workDir: workDir || require('path').dirname(scriptPath),
                submitScript: scriptPath,
                pendingReason: 'Priority',
            });
            return {
                success: true,
                jobId,
                message: `Mock job submitted successfully with ID: ${jobId}`,
            };
        }

        try {
            // Use the script's directory as working directory if not specified
            if (this.isRemoteMode()) {
                validateRemoteFilePath(scriptPath);
            }
            const cwd = workDir || (this.isRemoteMode()
                ? path.posix.dirname(scriptPath)
                : path.dirname(scriptPath));

            const { stdout } = await this.executor.run({
                command: 'sbatch',
                args: [scriptPath],
                cwd,
            });

            // sbatch typically outputs: "Submitted batch job <jobId>"
            const match = stdout.match(/Submitted batch job (\d+)/);
            if (match) {
                const jobId = match[1];
                return {
                    success: true,
                    jobId,
                    message: `Job submitted successfully with ID: ${jobId}`
                };
            }

            // If we got here, submission succeeded but couldn't parse job ID
            return {
                success: true,
                message: `Job submitted but couldn't parse job ID. Output: ${stdout}`
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to submit job from ${scriptPath}:`, error);
            return {
                success: false,
                message: `Failed to submit job: ${errorMessage}`
            };
        }
    }

    /**
     * Fetch job history using sacct
     * Shows recently completed/failed/cancelled jobs
     */
    async getJobHistory(days: number = 7): Promise<HistoryJob[]> {
        if (this.isMockMode()) {
            return createMockHistoryJobs().map(job => ({ ...job }));
        }

        try {
            const username = await this.getCurrentUsername();
            // Calculate start date (N days ago)
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
            const startDateStr = startDate.toISOString().split('T')[0];

            // sacct format: JobID|JobName|State|ExitCode|Start|End|Elapsed|Partition|NodeList|AllocCPUS|MaxRSS
            const { stdout } = await this.executor.run({
                command: 'sacct',
                args: [
                    '-u',
                    username,
                    `--starttime=${startDateStr}`,
                    '--noheader',
                    '--parsable2',
                    '--format=JobID,JobName,State,ExitCode,Start,End,Elapsed,Partition,NodeList,AllocCPUS,MaxRSS',
                ],
            });

            const jobs: HistoryJob[] = [];
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                const parts = line.split('|');
                if (parts.length >= 9) {
                    const jobId = parts[0].trim();

                    // Skip job steps (they contain a dot, like "12345.batch" or "12345.0")
                    if (jobId.includes('.')) {
                        continue;
                    }

                    const state = parts[2].trim();

                    // Skip jobs that are still running or pending
                    if (state === 'RUNNING' || state === 'PENDING') {
                        continue;
                    }

                    const exitCodeParts = parts[3].trim().split(':');
                    const exitCode = parseInt(exitCodeParts[0], 10) || 0;

                    jobs.push({
                        jobId: jobId,
                        name: parts[1].trim() || 'N/A',
                        state: state,
                        exitCode: exitCode,
                        startTime: parts[4].trim() || 'N/A',
                        endTime: parts[5].trim() || 'N/A',
                        elapsed: parts[6].trim() || 'N/A',
                        partition: parts[7].trim() || 'N/A',
                        nodes: parts[8].trim() || 'N/A',
                        cpus: parts[9]?.trim() || 'N/A',
                        maxMemory: parts[10]?.trim() || 'N/A',
                        stdoutPath: 'N/A',
                        stderrPath: 'N/A',
                    });
                }
            }

            // Sort by end time (most recent first)
            jobs.sort((a, b) => {
                if (a.endTime === 'N/A') return 1;
                if (b.endTime === 'N/A') return -1;
                return new Date(b.endTime).getTime() - new Date(a.endTime).getTime();
            });

            return jobs;
        } catch (error) {
            console.error('Failed to fetch job history:', error);
            return [];
        }
    }

    /**
     * Get stdout and stderr paths for a historical job
     * Tries: 1) local cache, 2) scontrol, 3) returns N/A
     */
    async getHistoryJobPaths(
        jobId: string,
        context: HistoryPathContext = {},
    ): Promise<{ stdoutPath: string; stderrPath: string }> {
        const jobName = context.jobName || jobId;
        const nodes = context.nodes || 'N/A';

        if (this.isMockMode()) {
            const job = createMockHistoryJobs().find(historyJob => historyJob.jobId === jobId);
            return {
                stdoutPath: job?.stdoutPath || 'N/A',
                stderrPath: job?.stderrPath || 'N/A',
            };
        }

        // First, check the local cache
        if (this.pathCache) {
            const cached = this.pathCache.get(this.getPathCacheKey(jobId));
            if (cached && shouldUseCachedOutputPaths(cached)) {
                return sanitizeOutputPathsForCache({
                    stdoutPath: await this.expandJobPath(cached.stdoutPath, jobId, jobName, nodes),
                    stderrPath: await this.expandJobPath(cached.stderrPath, jobId, jobName, nodes),
                });
            }
        }

        // Try scontrol (works for recent jobs still in the controller's memory)
        try {
            validateJobId(jobId);
            const { stdout } = await this.executor.run({
                command: 'scontrol',
                args: ['show', 'job', jobId],
            });
            const details = parseJobDetailsOutput(stdout);
            const paths = {
                stdoutPath: await this.expandJobPath(details.stdoutPath, jobId, jobName, nodes, details.workDir),
                stderrPath: await this.expandJobPath(details.stderrPath, jobId, jobName, nodes, details.workDir),
            };

            const cacheablePaths = sanitizeOutputPathsForCache(paths);
            if (shouldUseCachedOutputPaths(cacheablePaths)) {
                // Cache these for future use
                if (this.pathCache) {
                    await this.pathCache.set(this.getPathCacheKey(jobId), cacheablePaths.stdoutPath, cacheablePaths.stderrPath);
                }

                return cacheablePaths;
            }
        } catch {
            // scontrol failed, job may be too old
        }

        // No cached data available
        return {
            stdoutPath: 'N/A',
            stderrPath: 'N/A',
        };
    }
}

/**
 * Represents a completed SLURM job from sacct
 */
export interface HistoryJob {
    jobId: string;
    name: string;
    state: string;
    exitCode: number;
    startTime: string;
    endTime: string;
    elapsed: string;
    partition: string;
    nodes: string;
    cpus: string;
    maxMemory: string;
    stdoutPath: string;
    stderrPath: string;
}

/**
 * Get icon and color for job history state
 */
export function getHistoryStateInfo(state: string, exitCode: number): { icon: string; color: string; description: string } {
    // Handle states that indicate success
    if (state === 'COMPLETED' && exitCode === 0) {
        return { icon: 'check', color: 'charts.green', description: 'Completed Successfully' };
    }

    // Handle states that indicate failure
    if (state === 'COMPLETED' && exitCode !== 0) {
        return { icon: 'error', color: 'charts.red', description: `Failed (exit code ${exitCode})` };
    }

    if (state === 'FAILED') {
        return { icon: 'error', color: 'charts.red', description: 'Failed' };
    }

    if (state === 'TIMEOUT') {
        return { icon: 'clock', color: 'charts.orange', description: 'Timeout' };
    }

    if (state === 'CANCELLED' || state.startsWith('CANCELLED')) {
        return { icon: 'circle-slash', color: 'charts.orange', description: 'Cancelled' };
    }

    if (state === 'NODE_FAIL') {
        return { icon: 'error', color: 'charts.red', description: 'Node Failure' };
    }

    if (state === 'OUT_OF_MEMORY' || state === 'OUT_OF_ME+') {
        return { icon: 'warning', color: 'charts.red', description: 'Out of Memory' };
    }

    if (state === 'PREEMPTED') {
        return { icon: 'debug-pause', color: 'charts.yellow', description: 'Preempted' };
    }

    return { icon: 'circle-outline', color: 'foreground', description: state };
}
