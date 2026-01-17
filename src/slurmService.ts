import { exec } from 'child_process';
import { promisify } from 'util';

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
    
    return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${progress}%`;
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
 * Service for interacting with SLURM cluster
 */
export class SlurmService {
    /**
     * Fetch current user's jobs from SLURM
     * Uses squeue command with custom format for parsing
     */
    async getJobs(): Promise<SlurmJob[]> {
        try {
            // Format: JobID|Name|State|Time|Partition|NodeList|StdOut|StdErr|TimeLimit|StartTime|WorkDir
            const { stdout } = await execAsync(
                'squeue -u $USER --noheader --format="%i|%j|%t|%M|%P|%N|%o|%e|%l|%S|%Z"'
            );

            const jobs: SlurmJob[] = [];
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                const parts = line.split('|');
                if (parts.length >= 11) {
                    jobs.push({
                        jobId: parts[0].trim(),
                        name: parts[1].trim(),
                        state: parts[2].trim(),
                        time: parts[3].trim(),
                        partition: parts[4].trim(),
                        nodes: parts[5].trim() || 'N/A',
                        stdoutPath: parts[6].trim() || 'N/A',
                        stderrPath: parts[7].trim() || 'N/A',
                        timeLimit: parts[8].trim() || 'N/A',
                        startTime: parts[9].trim() || 'N/A',
                        workDir: parts[10].trim() || 'N/A',
                    });
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
}
