/** Whether Slurm commands can run, and if not, why */
export type SlurmAvailability =
    | { available: true }
    /** No Slurm here, or on `host` when commands run there over SSH */
    | { available: false; reason: 'missing'; host?: string }
    /** Commands run on `host` over SSH, and there's no connection to it */
    | { available: false; reason: 'disconnected'; host: string };

export type SlurmUnavailable = Exclude<SlurmAvailability, { available: true }>;

export const CONNECT_COMMAND = 'slurmClusterManager.connect';

export interface UnavailableMessage {
    label: string;
    description?: string;
    tooltip?: string;
    icon: string;
    command?: { command: string; title: string };
}

/**
 * The row a view shows when Slurm can't be reached. Where connecting over SSH
 * would help, the row is the way to do it.
 * @param missingLabel what the view says when Slurm isn't on this machine
 * @param canConnectOverSsh whether this platform supports connecting over SSH
 */
export function describeUnavailable(
    availability: SlurmUnavailable,
    missingLabel: string,
    canConnectOverSsh: boolean,
): UnavailableMessage {
    const connect = { command: CONNECT_COMMAND, title: 'Connect to Cluster' };

    if (availability.reason === 'disconnected') {
        return {
            label: `Not connected to ${availability.host}`,
            description: 'Click to connect',
            tooltip: `Slurm commands run on ${availability.host} over SSH. Click to log in.`,
            icon: 'debug-disconnect',
            command: connect,
        };
    }

    if (availability.host) {
        return {
            label: `SLURM not found on ${availability.host}`,
            tooltip: `squeue didn't run on ${availability.host}. Check that it's a login node of your cluster.`,
            icon: 'warning',
        };
    }

    return canConnectOverSsh
        ? {
            label: missingLabel,
            description: 'Connect over SSH',
            tooltip: 'Slurm commands aren\'t available on this machine. Click to run them on your cluster over SSH.',
            icon: 'warning',
            command: connect,
        }
        : { label: missingLabel, icon: 'warning' };
}
