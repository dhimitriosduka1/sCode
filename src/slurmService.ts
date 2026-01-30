import { exec } from 'child_process';
import { promisify } from 'util';
import { JobPathCache } from './jobPathCache';
import { SubmitScriptCache } from './submitScriptCache';

const execAsync = promisify(exec);

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
    path: string,
    jobId: string,
    jobName: string,
    nodes: string
): string {
    if (!path || path === 'N/A') {
        return path;
    }

    let expanded = path;

    // Common SLURM filename patterns:
    // %j - job ID
    // %x - job name
    // %u - username (we'll get from os)
    // %N - first node name
    // %A - job array master ID
    // %a - job array index
    // %t - task ID

    expanded = expanded.replace(/%j/g, jobId);
    expanded = expanded.replace(/%x/g, jobName);

    // Get username
    try {
        const username = require('os').userInfo().username;
        expanded = expanded.replace(/%u/g, username);
    } catch {
        expanded = expanded.replace(/%u/g, 'user');
    }

    // Node name - use first node if available, otherwise use placeholder
    if (nodes && nodes !== 'N/A') {
        expanded = expanded.replace(/%N/g, nodes.split(',')[0].split('[')[0]);
    } else {
        // For pending jobs, we can't know the node yet - mark as pending
        if (expanded.includes('%N')) {
            expanded = expanded.replace(/%N/g, 'PENDING_NODE');
        }
    }

    // Job array placeholders
    const arrayParts = jobId.split('_');
    expanded = expanded.replace(/%A/g, arrayParts[0]); // Master job ID
    expanded = expanded.replace(/%a/g, arrayParts.length > 1 ? arrayParts[1] : '0'); // Array index
    expanded = expanded.replace(/%t/g, '0'); // Task ID
    expanded = expanded.replace(/%%/g, '%'); // Escaped percent

    return expanded;
}

/**
 * Job details fetched from scontrol
 */
interface JobDetails {
    stdoutPath: string;
    stderrPath: string;
    submitScript: string;
    workDir: string;
}

/**
 * Service for interacting with SLURM cluster
 */
export class SlurmService {
    private pathCache?: JobPathCache;
    private scriptCache?: SubmitScriptCache;

    constructor(pathCache?: JobPathCache, scriptCache?: SubmitScriptCache) {
        this.pathCache = pathCache;
        this.scriptCache = scriptCache;
    }

    /**
     * Fetch current user's jobs from SLURM
     * Uses squeue command with custom format for parsing
     */
    async getJobs(): Promise<SlurmJob[]> {
        try {
            // Format: JobID|Name|State|Time|Partition|NodeList|TimeLimit|StartTime
            const { stdout } = await execAsync(
                'squeue -u $USER --noheader --format="%i|%j|%t|%M|%P|%N|%l|%S"'
            );

            const jobs: SlurmJob[] = [];
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                const parts = line.split('|');
                if (parts.length >= 8) {
                    const jobId = parts[0].trim();
                    const job: SlurmJob = {
                        jobId: jobId,
                        name: parts[1].trim(),
                        state: parts[2].trim(),
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

                    jobs.push(job);
                }
            }

            // Fetch detailed info (stdout, stderr, command) from scontrol for all jobs in parallel
            await Promise.all(jobs.map(async (job) => {
                const details = await this.getJobDetails(job.jobId);
                // Expand any remaining placeholders in paths
                job.stdoutPath = expandPathPlaceholders(details.stdoutPath, job.jobId, job.name, job.nodes);
                job.stderrPath = expandPathPlaceholders(details.stderrPath, job.jobId, job.name, job.nodes);
                job.submitScript = details.submitScript;
                job.workDir = details.workDir;
                job.gpuCount = details.gpuCount;
                job.gpuType = details.gpuType;
                job.memory = details.memory;

                // Cache the paths for later use in history
                if (this.pathCache) {
                    await this.pathCache.set(job.jobId, job.stdoutPath, job.stderrPath);
                }

                // Cache the submit script if not already cached
                if (this.scriptCache && job.submitScript && job.submitScript !== 'N/A') {
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
    async getJobDetails(jobId: string): Promise<JobDetails & { gpuCount?: number; gpuType?: string; memory?: string }> {
        try {
            const { stdout } = await execAsync(`scontrol show job ${jobId}`);

            // Parse fields from scontrol output
            const stdoutMatch = stdout.match(/StdOut=([^\s]+)/);
            const stderrMatch = stdout.match(/StdErr=([^\s]+)/);
            const commandMatch = stdout.match(/Command=([^\s]+)/);
            const workDirMatch = stdout.match(/WorkDir=([^\s]+)/);

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
                    // Try to get type and count (e.g., "gpu:a100:2")
                    const gpuTypeCountMatch = gresMatch[1].match(/gpu:([^:]+):(\d+)/);
                    if (gpuTypeCountMatch) {
                        gpuType = gpuTypeCountMatch[1].toUpperCase();
                        gpuCount = parseInt(gpuTypeCountMatch[2], 10);
                    } else {
                        // Just count (e.g., "gpu:4")
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
                // Convert to human-readable format
                if (unit === 'M' && value >= 1000) {
                    memory = `${Math.round(value / 1000)}G`;
                } else {
                    memory = `${value}${unit}`;
                }
            }

            return {
                stdoutPath: stdoutMatch?.[1] || 'N/A',
                stderrPath: stderrMatch?.[1] || 'N/A',
                submitScript: commandMatch?.[1] || 'N/A',
                workDir: workDirMatch?.[1] || 'N/A',
                gpuCount,
                gpuType,
                memory,
            };
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
        try {
            await execAsync('which squeue');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get GPU information using nvidia-smi
     * @returns Object with GPU name and memory, or null if unavailable
     */
    async getGpuInfo(): Promise<{ gpuName: string; gpuMemory: string } | null> {
        try {
            // Run both nvidia-smi commands in parallel
            const [nameResult, memoryResult] = await Promise.all([
                execAsync('nvidia-smi --query-gpu=name --format=csv,noheader'),
                execAsync('nvidia-smi --query-gpu=memory.total --format=csv,noheader'),
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
     * Get the user with the most running jobs on the cluster (for fun!)
     * @returns Object with username and job count, or null if unavailable
     */
    async getTopJobHog(): Promise<{ username: string; jobCount: number } | null> {
        try {
            // Get all running jobs on the cluster with their usernames
            const { stdout } = await execAsync(
                'squeue --noheader --state=R --format="%u"'
            );

            const users = stdout.trim().split('\n').filter(u => u.trim());

            if (users.length === 0) {
                return null;
            }

            // Count jobs per user
            const jobCounts = new Map<string, number>();
            for (const user of users) {
                const trimmedUser = user.trim();
                jobCounts.set(trimmedUser, (jobCounts.get(trimmedUser) || 0) + 1);
            }

            // Find the user with most jobs
            let topUser = '';
            let maxJobs = 0;
            jobCounts.forEach((count, user) => {
                if (count > maxJobs) {
                    maxJobs = count;
                    topUser = user;
                }
            });

            return { username: topUser, jobCount: maxJobs };
        } catch (error) {
            console.error('Failed to get top job hog:', error);
            return null;
        }
    }

    /**
     * Cancel a SLURM job using scancel
     * @param jobId The job ID to cancel
     * @returns Object with success status and optional error message
     */
    async cancelJob(jobId: string): Promise<{ success: boolean; message: string }> {
        try {
            await execAsync(`scancel ${jobId}`);
            return { success: true, message: `Job ${jobId} cancelled successfully` };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to cancel job ${jobId}:`, error);
            return { success: false, message: `Failed to cancel job ${jobId}: ${errorMessage}` };
        }
    }

    /**
     * Submit a SLURM job using sbatch
     * @param scriptPath Path to the submit script
     * @param workDir Optional working directory (defaults to script's parent directory)
     * @returns Object with success status, job ID (if successful), and message
     */
    async submitJob(scriptPath: string, workDir?: string): Promise<{ success: boolean; jobId?: string; message: string }> {
        try {
            // Use the script's directory as working directory if not specified
            const cwd = workDir || require('path').dirname(scriptPath);

            const { stdout, stderr } = await execAsync(`sbatch "${scriptPath}"`, { cwd });

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
        try {
            // Calculate start date (N days ago)
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - days);
            const startDateStr = startDate.toISOString().split('T')[0];

            // sacct format: JobID|JobName|State|ExitCode|Start|End|Elapsed|Partition|NodeList|AllocCPUS|MaxRSS
            const { stdout } = await execAsync(
                `sacct -u $USER --starttime=${startDateStr} --noheader --parsable2 --format=JobID,JobName,State,ExitCode,Start,End,Elapsed,Partition,NodeList,AllocCPUS,MaxRSS`
            );

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
    async getHistoryJobPaths(jobId: string): Promise<{ stdoutPath: string; stderrPath: string }> {
        // First, check the local cache
        if (this.pathCache) {
            const cached = this.pathCache.get(jobId);
            if (cached) {
                return {
                    stdoutPath: cached.stdoutPath,
                    stderrPath: cached.stderrPath,
                };
            }
        }

        // Try scontrol (works for recent jobs still in the controller's memory)
        try {
            const { stdout } = await execAsync(`scontrol show job ${jobId} 2>/dev/null`);

            const stdoutMatch = stdout.match(/StdOut=([^\s]+)/);
            const stderrMatch = stdout.match(/StdErr=([^\s]+)/);

            if (stdoutMatch || stderrMatch) {
                const paths = {
                    stdoutPath: stdoutMatch?.[1] || 'N/A',
                    stderrPath: stderrMatch?.[1] || 'N/A',
                };

                // Cache these for future use
                if (this.pathCache) {
                    await this.pathCache.set(jobId, paths.stdoutPath, paths.stderrPath);
                }

                return paths;
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
