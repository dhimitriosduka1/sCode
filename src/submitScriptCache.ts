import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DeferredSave } from './deferredSave';

/**
 * Cached submit script information
 */
export interface CachedSubmitScript {
    originalPath: string;
    cachedPath: string;
    cachedAt: number; // timestamp
}

/**
 * Cache for storing submit scripts at submission time
 * Uses VS Code's globalStorageUri for file storage and globalState for metadata
 */
export class SubmitScriptCache {
    private static readonly CACHE_KEY = 'slurmSubmitScriptCache';
    private static readonly CACHE_DIR = 'submit-scripts';
    private static readonly MAX_AGE_DAYS = 30; // Clean up entries older than this

    private context: vscode.ExtensionContext;
    private cache: Map<string, CachedSubmitScript>;
    private cacheDir: string;
    private readonly deferredSave = new DeferredSave(() => this.saveCache());

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.cacheDir = path.join(context.globalStorageUri.fsPath, SubmitScriptCache.CACHE_DIR);
        this.cache = this.loadCache();
        this.ensureCacheDir();
        this.cleanupOldEntries();
    }

    /**
     * Ensure the cache directory exists
     */
    private ensureCacheDir(): void {
        try {
            if (!fs.existsSync(this.cacheDir)) {
                fs.mkdirSync(this.cacheDir, { recursive: true });
            }
        } catch (error) {
            console.error('Failed to create submit script cache directory:', error);
        }
    }

    /**
     * Load cache metadata from globalState
     */
    private loadCache(): Map<string, CachedSubmitScript> {
        const stored = this.context.globalState.get<Record<string, CachedSubmitScript>>(SubmitScriptCache.CACHE_KEY, {});
        return new Map(Object.entries(stored));
    }

    /**
     * Save cache metadata to globalState
     */
    private async saveCache(): Promise<void> {
        const obj: Record<string, CachedSubmitScript> = {};
        this.cache.forEach((value, key) => {
            obj[key] = value;
        });
        await this.context.globalState.update(SubmitScriptCache.CACHE_KEY, obj);
    }

    /**
     * Remove entries older than MAX_AGE_DAYS and their cached files
     */
    private cleanupOldEntries(): void {
        const maxAgeMs = SubmitScriptCache.MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let cleaned = false;

        this.cache.forEach((value, key) => {
            if (now - value.cachedAt > maxAgeMs) {
                // Delete the cached file
                try {
                    if (fs.existsSync(value.cachedPath)) {
                        fs.unlinkSync(value.cachedPath);
                    }
                } catch (error) {
                    console.error(`Failed to delete cached script for job ${key}:`, error);
                }

                this.cache.delete(key);
                cleaned = true;
            }
        });

        if (cleaned) {
            this.saveCache();
        }
    }

    /**
     * Cache a submit script for a job
     * @param jobId The SLURM job ID
     * @param originalScriptPath The path to the original submit script
     * @returns The path to the cached script, or undefined if caching failed
     */
    async cacheScript(jobId: string, originalScriptPath: string, cluster?: string): Promise<string | undefined> {
        const key = SubmitScriptCache.key(jobId, cluster);
        // Skip if already cached
        if (this.cache.has(key)) {
            return this.cache.get(key)?.cachedPath;
        }

        // Skip if original path is not available
        if (!originalScriptPath || originalScriptPath === 'N/A') {
            return undefined;
        }

        // Skip if original file doesn't exist
        if (!fs.existsSync(originalScriptPath)) {
            console.warn(`Submit script not found for job ${jobId}: ${originalScriptPath}`);
            return undefined;
        }

        try {
            // Create a unique filename using job ID and timestamp
            const timestamp = Date.now();
            const ext = path.extname(originalScriptPath) || '.sh';
            const cachedFilename = `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}_${timestamp}${ext}`;
            const cachedPath = path.join(this.cacheDir, cachedFilename);

            // Copy the file
            fs.copyFileSync(originalScriptPath, cachedPath);

            // Store metadata
            const entry: CachedSubmitScript = {
                originalPath: originalScriptPath,
                cachedPath: cachedPath,
                cachedAt: timestamp,
            };

            this.cache.set(key, entry);
            this.deferredSave.schedule();

            console.log(`Cached submit script for job ${jobId}: ${cachedPath}`);
            return cachedPath;
        } catch (error) {
            console.error(`Failed to cache submit script for job ${jobId}:`, error);
            return undefined;
        }
    }

    /**
     * Entries are kept per cluster, since job IDs repeat across clusters; jobs
     * on this machine keep the bare job ID they always had. Every task of an
     * array (123_4, 123_[5-9%2]) was submitted with one script, so they share
     * the base job ID's entry instead of each copying the file.
     */
    private static key(jobId: string, cluster?: string): string {
        const baseJobId = /^(\d+)/.exec(jobId)?.[1] ?? jobId;
        return cluster ? `${cluster}:${baseJobId}` : baseJobId;
    }

    /** Writes any pending change now. */
    flush(): Promise<void> {
        return this.deferredSave.flush();
    }

    dispose(): void {
        this.flush().catch(error => console.error('Failed to save cache:', error));
    }

    /**
     * Get cached script info for a job
     */
    get(jobId: string, cluster?: string): CachedSubmitScript | undefined {
        return this.cache.get(SubmitScriptCache.key(jobId, cluster));
    }

    /**
     * Get the cached script path for a job
     */
    getCachedScriptPath(jobId: string, cluster?: string): string | undefined {
        return this.get(jobId, cluster)?.cachedPath;
    }

    /**
     * Get the original script path at submission time for a job
     */
    getOriginalScriptPath(jobId: string, cluster?: string): string | undefined {
        return this.get(jobId, cluster)?.originalPath;
    }

    /**
     * Check if a job has a cached script
     */
    has(jobId: string, cluster?: string): boolean {
        return this.cache.has(SubmitScriptCache.key(jobId, cluster));
    }

    /**
     * Get the number of cached scripts
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Clear all cached entries and files
     */
    async clear(): Promise<void> {
        // Delete all cached files
        this.cache.forEach((value) => {
            try {
                if (fs.existsSync(value.cachedPath)) {
                    fs.unlinkSync(value.cachedPath);
                }
            } catch (error) {
                console.error('Failed to delete cached script:', error);
            }
        });

        this.cache.clear();
        this.deferredSave.schedule();
        await this.deferredSave.flush();
    }

    /**
     * Format the cache timestamp for display
     */
    formatCacheTime(jobId: string, cluster?: string): string {
        const entry = this.get(jobId, cluster);
        if (!entry) {
            return 'N/A';
        }

        const date = new Date(entry.cachedAt);
        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    }
}
