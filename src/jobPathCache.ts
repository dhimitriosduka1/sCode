import * as vscode from 'vscode';

/**
 * Cached job path information
 */
export interface CachedJobPaths {
    stdoutPath: string;
    stderrPath: string;
    cachedAt: number; // timestamp
}

/**
 * Cache for storing job stdout/stderr paths
 * Uses VS Code's globalState for persistence across sessions
 */
export class JobPathCache {
    private static readonly CACHE_KEY = 'slurmJobPathCache';
    private static readonly MAX_AGE_DAYS = 30; // Clean up entries older than this

    private context: vscode.ExtensionContext;
    private cache: Map<string, CachedJobPaths>;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.cache = this.loadCache();
        this.cleanupOldEntries();
    }

    /**
     * Load cache from globalState
     */
    private loadCache(): Map<string, CachedJobPaths> {
        const stored = this.context.globalState.get<Record<string, CachedJobPaths>>(JobPathCache.CACHE_KEY, {});
        return new Map(Object.entries(stored));
    }

    /**
     * Save cache to globalState
     */
    private async saveCache(): Promise<void> {
        const obj: Record<string, CachedJobPaths> = {};
        this.cache.forEach((value, key) => {
            obj[key] = value;
        });
        await this.context.globalState.update(JobPathCache.CACHE_KEY, obj);
    }

    /**
     * Remove entries older than MAX_AGE_DAYS
     */
    private cleanupOldEntries(): void {
        const maxAgeMs = JobPathCache.MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let cleaned = false;

        this.cache.forEach((value, key) => {
            if (now - value.cachedAt > maxAgeMs) {
                this.cache.delete(key);
                cleaned = true;
            }
        });

        if (cleaned) {
            this.saveCache();
        }
    }

    /**
     * Get cached paths for a job
     */
    get(jobId: string): CachedJobPaths | undefined {
        return this.cache.get(jobId);
    }

    /**
     * Cache paths for a job
     */
    async set(jobId: string, stdoutPath: string, stderrPath: string): Promise<void> {
        // Only cache if we have valid paths
        if ((!stdoutPath || stdoutPath === 'N/A') && (!stderrPath || stderrPath === 'N/A')) {
            return;
        }

        this.cache.set(jobId, {
            stdoutPath: stdoutPath || 'N/A',
            stderrPath: stderrPath || 'N/A',
            cachedAt: Date.now(),
        });

        await this.saveCache();
    }

    /**
     * Check if a job is cached
     */
    has(jobId: string): boolean {
        return this.cache.has(jobId);
    }

    /**
     * Get the number of cached entries
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Clear all cached entries
     */
    async clear(): Promise<void> {
        this.cache.clear();
        await this.saveCache();
    }
}
