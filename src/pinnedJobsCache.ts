import * as vscode from 'vscode';

/**
 * Cache for storing pinned job IDs
 * Uses VS Code's globalState for persistence across sessions
 */
export class PinnedJobsCache {
    private static readonly CACHE_KEY = 'slurmPinnedJobs';
    private static readonly STALE_DAYS = 7; // Remove pinned jobs older than this if they don't exist

    private context: vscode.ExtensionContext;
    private pinnedJobs: Map<string, number>; // jobId -> timestamp when pinned

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.pinnedJobs = this.loadCache();
    }

    /**
     * Load cache from globalState
     */
    private loadCache(): Map<string, number> {
        const stored = this.context.globalState.get<Record<string, number>>(PinnedJobsCache.CACHE_KEY, {});
        return new Map(Object.entries(stored));
    }

    /**
     * Save cache to globalState
     */
    private async saveCache(): Promise<void> {
        const obj: Record<string, number> = {};
        this.pinnedJobs.forEach((timestamp, jobId) => {
            obj[jobId] = timestamp;
        });
        await this.context.globalState.update(PinnedJobsCache.CACHE_KEY, obj);
    }

    /**
     * Pin a job
     */
    async pin(jobId: string): Promise<void> {
        this.pinnedJobs.set(jobId, Date.now());
        await this.saveCache();
    }

    /**
     * Unpin a job
     */
    async unpin(jobId: string): Promise<void> {
        this.pinnedJobs.delete(jobId);
        await this.saveCache();
    }

    /**
     * Check if a job is pinned
     */
    isPinned(jobId: string): boolean {
        return this.pinnedJobs.has(jobId);
    }

    /**
     * Get all pinned job IDs
     */
    getPinnedJobIds(): string[] {
        return Array.from(this.pinnedJobs.keys());
    }

    /**
     * Get the number of pinned jobs
     */
    get size(): number {
        return this.pinnedJobs.size;
    }

    /**
     * Clear all pinned jobs
     */
    async clear(): Promise<void> {
        this.pinnedJobs.clear();
        await this.saveCache();
    }

    /**
     * Clean up stale pinned jobs that no longer exist in the active job list
     * Call this periodically with the current list of active job IDs
     */
    async cleanupStaleJobs(activeJobIds: Set<string>): Promise<void> {
        const now = Date.now();
        const staleThreshold = PinnedJobsCache.STALE_DAYS * 24 * 60 * 60 * 1000;
        let cleaned = false;

        this.pinnedJobs.forEach((timestamp, jobId) => {
            // Remove if: job doesn't exist AND was pinned more than STALE_DAYS ago
            if (!activeJobIds.has(jobId) && (now - timestamp) > staleThreshold) {
                this.pinnedJobs.delete(jobId);
                cleaned = true;
            }
        });

        if (cleaned) {
            await this.saveCache();
        }
    }
}
