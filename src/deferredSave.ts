/**
 * Coalesces many cache changes into one write.
 *
 * The job path and submit script caches live in `globalState`, and every update
 * there serializes the whole map (and, in a remote window, ships it to the
 * client). Writing once per job made a refresh of 193 jobs over a 33,000-entry
 * cache serialize 1.5 GB and take 6 s; one deferred write per burst does not.
 */
export class DeferredSave {
    private timer: ReturnType<typeof setTimeout> | undefined;
    /** The last write started; each one waits for the one before. */
    private saving: Promise<void> = Promise.resolve();

    constructor(
        private readonly save: () => Promise<void>,
        private readonly delayMs = 2000,
    ) {}

    /** Writes once, `delayMs` after the first change since the last write. */
    schedule(): void {
        if (this.timer) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.startSave().catch(error => console.error('Failed to save cache:', error));
        }, this.delayMs);
        // A pending write must not keep a test process (or the host) alive
        this.timer.unref?.();
    }

    /** Writes now if a write is pending, and waits for a write already under way. */
    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
            await this.startSave();
            return;
        }
        // A failure of that write was reported when it happened
        await this.saving.catch(() => undefined);
    }

    private startSave(): Promise<void> {
        this.saving = this.saving.catch(() => undefined).then(() => this.save());
        return this.saving;
    }

    get pending(): boolean {
        return this.timer !== undefined;
    }
}
