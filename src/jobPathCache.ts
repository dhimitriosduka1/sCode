import * as vscode from 'vscode';
import { DeferredSave } from './deferredSave';

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
    private readonly deferredSave = new DeferredSave(() => this.saveCache());

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

        const stdout = stdoutPath || 'N/A';
        const stderr = stderrPath || 'N/A';
        // Every refresh reports the same paths for every active job; only a change is worth a write
        const existing = this.cache.get(jobId);
        if (existing && existing.stdoutPath === stdout && existing.stderrPath === stderr) {
            return;
        }

        this.cache.set(jobId, {
            stdoutPath: stdout,
            stderrPath: stderr,
            cachedAt: Date.now(),
        });

        this.deferredSave.schedule();
    }

    /** Writes any pending change now. */
    flush(): Promise<void> {
        return this.deferredSave.flush();
    }

    dispose(): void {
        this.flush().catch(error => console.error('Failed to save cache:', error));
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
        this.deferredSave.schedule();
        await this.deferredSave.flush();
    }
}
