export type ConnectionMode = 'local' | 'ssh';

export interface SlurmClusterProfile {
    name: string;
    connectionMode: ConnectionMode;
    sshHost?: string;
    sshConnectTimeout?: number;
    remoteLogMaxBytes?: number;
}

export interface ClusterResolutionSettings {
    activeCluster?: string;
    clusters?: unknown;
    connectionMode?: ConnectionMode;
    sshHost?: string;
    sshConnectTimeout?: number;
    remoteLogMaxBytes?: number;
}

export const LOCAL_CLUSTER_NAME = 'local';

export function normalizeSshConnectTimeout(timeout: number | undefined): number {
    if (!timeout || !Number.isFinite(timeout)) {
        return 10;
    }

    return Math.min(120, Math.max(1, Math.round(timeout)));
}

export function normalizeRemoteLogMaxBytes(maxBytes: number | undefined): number {
    if (!maxBytes || !Number.isFinite(maxBytes)) {
        return 2 * 1024 * 1024;
    }

    return Math.max(1024, Math.floor(maxBytes));
}

export function validateSshHost(host: string): void {
    if (!host.trim()) {
        throw new Error('SSH host is required');
    }

    if (host.trim().startsWith('-') || /\s/.test(host) || /[\0\r\n]/.test(host)) {
        throw new Error('Enter a host alias or user@host value without whitespace');
    }
}

export function validateClusterName(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error('Cluster name is required');
    }

    if (trimmed.toLowerCase() === LOCAL_CLUSTER_NAME) {
        throw new Error('"local" is reserved for local Slurm');
    }

    if (/[\0\r\n]/.test(trimmed)) {
        throw new Error('Cluster name cannot contain control characters');
    }
}

export function inferClusterNameFromHost(host: string): string {
    const trimmedHost = host.trim();
    const withoutUser = trimmedHost.includes('@') ? trimmedHost.split('@').pop() || trimmedHost : trimmedHost;
    const firstHostPart = withoutUser.split('.')[0] || withoutUser;
    return firstHostPart.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'remote-cluster';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeClusterProfile(value: unknown): SlurmClusterProfile | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const connectionMode = value.connectionMode === 'ssh' ? 'ssh' : value.connectionMode === 'local' ? 'local' : undefined;
    if (!name || !connectionMode) {
        return undefined;
    }

    try {
        validateClusterName(name);
    } catch {
        return undefined;
    }

    if (connectionMode === 'local') {
        return { name, connectionMode: 'local' };
    }

    const sshHost = typeof value.sshHost === 'string' ? value.sshHost.trim() : '';
    try {
        validateSshHost(sshHost);
    } catch {
        return undefined;
    }

    return {
        name,
        connectionMode: 'ssh',
        sshHost,
        sshConnectTimeout: normalizeSshConnectTimeout(
            typeof value.sshConnectTimeout === 'number' ? value.sshConnectTimeout : undefined
        ),
        remoteLogMaxBytes: normalizeRemoteLogMaxBytes(
            typeof value.remoteLogMaxBytes === 'number' ? value.remoteLogMaxBytes : undefined
        ),
    };
}

export function normalizeClusterProfiles(value: unknown): SlurmClusterProfile[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const profiles: SlurmClusterProfile[] = [];
    const seenNames = new Set<string>();

    for (const rawProfile of value) {
        const profile = normalizeClusterProfile(rawProfile);
        if (!profile || seenNames.has(profile.name.toLowerCase())) {
            continue;
        }

        seenNames.add(profile.name.toLowerCase());
        profiles.push(profile);
    }

    return profiles;
}

export function mergeClusterProfiles(...profileSets: SlurmClusterProfile[][]): SlurmClusterProfile[] {
    const merged: SlurmClusterProfile[] = [];
    const seenNames = new Set<string>();

    for (const profiles of profileSets) {
        for (const profile of profiles) {
            const key = profile.name.toLowerCase();
            const existingIndex = merged.findIndex(existing => existing.name.toLowerCase() === key);
            if (existingIndex >= 0) {
                merged[existingIndex] = profile;
                seenNames.add(key);
                continue;
            }

            if (!seenNames.has(key)) {
                merged.push(profile);
                seenNames.add(key);
            }
        }
    }

    return merged;
}

export function getLocalClusterProfile(): SlurmClusterProfile {
    return { name: LOCAL_CLUSTER_NAME, connectionMode: 'local' };
}

export function resolveActiveClusterProfile(settings: ClusterResolutionSettings): SlurmClusterProfile {
    const activeCluster = settings.activeCluster?.trim();
    if (activeCluster?.toLowerCase() === LOCAL_CLUSTER_NAME) {
        return getLocalClusterProfile();
    }

    const profiles = normalizeClusterProfiles(settings.clusters);
    const activeProfile = profiles.find(profile => profile.name.toLowerCase() === activeCluster?.toLowerCase());
    if (activeProfile) {
        return activeProfile;
    }

    if (settings.connectionMode === 'ssh' && settings.sshHost?.trim()) {
        return {
            name: inferClusterNameFromHost(settings.sshHost),
            connectionMode: 'ssh',
            sshHost: settings.sshHost.trim(),
            sshConnectTimeout: normalizeSshConnectTimeout(settings.sshConnectTimeout),
            remoteLogMaxBytes: normalizeRemoteLogMaxBytes(settings.remoteLogMaxBytes),
        };
    }

    return getLocalClusterProfile();
}

export function upsertClusterProfile(profiles: SlurmClusterProfile[], profile: SlurmClusterProfile): SlurmClusterProfile[] {
    validateClusterName(profile.name);
    if (profile.connectionMode === 'ssh') {
        validateSshHost(profile.sshHost ?? '');
    }

    const normalizedProfile: SlurmClusterProfile = profile.connectionMode === 'ssh'
        ? {
            name: profile.name.trim(),
            connectionMode: 'ssh',
            sshHost: profile.sshHost?.trim(),
            sshConnectTimeout: normalizeSshConnectTimeout(profile.sshConnectTimeout),
            remoteLogMaxBytes: normalizeRemoteLogMaxBytes(profile.remoteLogMaxBytes),
        }
        : {
            name: profile.name.trim(),
            connectionMode: 'local',
        };

    const result = normalizeClusterProfiles(profiles)
        .filter(existing => existing.name.toLowerCase() !== normalizedProfile.name.toLowerCase());
    result.push(normalizedProfile);
    return result;
}

export function formatClusterProfileLabel(profile: SlurmClusterProfile): string {
    if (profile.connectionMode === 'local') {
        return 'Local';
    }

    return profile.name;
}

export function formatClusterProfileDescription(profile: SlurmClusterProfile): string {
    if (profile.connectionMode === 'local') {
        return 'Run Slurm commands on this machine';
    }

    return profile.sshHost ?? 'SSH';
}
