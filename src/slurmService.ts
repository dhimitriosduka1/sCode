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
 * Service for interacting with SLURM cluster
 */
export class SlurmService {
    /**
     * Fetch current user's jobs from SLURM
     * Uses squeue command with custom format for parsing
     */
    async getJobs(): Promise<SlurmJob[]> {
        try {
            // Format: JobID|Name|State|Time|Partition|NodeList
            const { stdout } = await execAsync(
                'squeue -u $USER --noheader --format="%i|%j|%t|%M|%P|%N"'
            );

            const jobs: SlurmJob[] = [];
            const lines = stdout.trim().split('\n');

            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }

                const parts = line.split('|');
                if (parts.length >= 6) {
                    jobs.push({
                        jobId: parts[0].trim(),
                        name: parts[1].trim(),
                        state: parts[2].trim(),
                        time: parts[3].trim(),
                        partition: parts[4].trim(),
                        nodes: parts[5].trim() || 'N/A',
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
