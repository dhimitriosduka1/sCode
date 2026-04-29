export const REMOTE_SLURM_SCHEME = 'slurm-remote';

const CONNECTION_QUERY_KEY = 'connection';

export function createRemoteSlurmQuery(connectionKey?: string): string | undefined {
    if (!connectionKey) {
        return undefined;
    }

    return `${CONNECTION_QUERY_KEY}=${encodeURIComponent(connectionKey)}`;
}

export function parseRemoteSlurmConnectionKey(query: string): string | undefined {
    if (!query) {
        return undefined;
    }

    const params = new URLSearchParams(query);
    return params.get(CONNECTION_QUERY_KEY) ?? undefined;
}

export function getRemoteSlurmConnectionMismatch(expectedConnectionKey: string | undefined, activeConnectionKey: string): string | undefined {
    if (!expectedConnectionKey || expectedConnectionKey === activeConnectionKey) {
        return undefined;
    }

    return `This remote document belongs to ${expectedConnectionKey}, but the active SLURM connection is ${activeConnectionKey}. Switch back to the original cluster and reopen the file.`;
}
