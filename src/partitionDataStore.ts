import { buildPartitionLoads, PartitionLoad } from './partitionCompletion';
import { CpuPartitionUsage, PartitionUsageResult } from './slurmService';

/** One fetch of partition data, shared by GPU Partition Usage and partition autocomplete. */
export interface PartitionSnapshot {
    usage: PartitionUsageResult;
    /** Every partition, CPU-only ones included, least occupied first */
    loads: PartitionLoad[];
    fetchedAt: Date;
}

/** The Slurm queries behind a snapshot; a subset of SlurmService so tests can fake it. */
export interface PartitionDataSource {
    isAvailable(): Promise<boolean>;
    getPartitionUsage(): Promise<PartitionUsageResult>;
    getCpuPartitionUsage(): Promise<CpuPartitionUsage[]>;
}

/**
 * The latest partition snapshot, refreshed on a schedule and on demand.
 * Kept free of `vscode` so the caching rules are unit-testable.
 *
 * Every refresh replaces the snapshot, whoever triggered it, so the tree and
 * autocomplete always agree. Concurrent refreshes share one set of queries.
 */
export class PartitionDataStore {
    private current: PartitionSnapshot | undefined;
    private pending: Promise<PartitionSnapshot> | undefined;
    private readonly listeners = new Set<() => void>();

    constructor(private readonly source: PartitionDataSource) {}

    /** The latest snapshot, or undefined before the first refresh completes. */
    get snapshot(): PartitionSnapshot | undefined {
        return this.current;
    }

    /** Re-queries Slurm and replaces the snapshot, joining a refresh already in flight. */
    refresh(): Promise<PartitionSnapshot> {
        this.pending ??= this.fetch().finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }

    /** The current snapshot, fetching the first one if there is none yet. */
    getSnapshot(): Promise<PartitionSnapshot> {
        return this.current ? Promise.resolve(this.current) : this.refresh();
    }

    /** Drops the snapshot, e.g. when mock mode switches the data source. */
    clear(): void {
        this.current = undefined;
    }

    /** Subscribes to snapshot replacements; returns an unsubscribe function. */
    onDidChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private async fetch(): Promise<PartitionSnapshot> {
        const [usage, cpuUsage] = await this.source.isAvailable()
            ? await Promise.all([this.source.getPartitionUsage(), this.source.getCpuPartitionUsage()])
            : [{ entries: [], clusterAllocatedGpus: 0, clusterAvailableGpus: 0 }, []];

        const snapshot: PartitionSnapshot = {
            usage,
            loads: buildPartitionLoads(usage.entries, cpuUsage),
            fetchedAt: new Date(),
        };

        // A cluster always has partitions, so an empty answer means the queries
        // failed; keep showing the last good data rather than blanking everything
        if (snapshot.loads.length === 0 && this.current && this.current.loads.length > 0) {
            return this.current;
        }

        this.current = snapshot;
        this.listeners.forEach(listener => listener());
        return snapshot;
    }
}
