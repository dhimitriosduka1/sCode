/**
 * Timer policy for auto-refresh.
 *
 * Kept free of vscode imports so it can be unit tested directly.
 *
 * The scheduler only ticks while the window is focused. The tree providers fetch
 * lazily inside getChildren(), which VS Code calls only when it renders, so ticking
 * in the background would not refresh anything - it would just mark the trees dirty
 * over and over and let every one of those fetches land at once on refocus.
 *
 * On regaining focus it waits out the remainder of the current period instead of
 * firing straight away, so tabbing away and back does not trigger an extra refresh.
 */
export class AutoRefreshScheduler {
    private intervalMs: number = 0;
    private onRefresh: (() => void) | undefined;
    private intervalTimer: ReturnType<typeof setInterval> | undefined;
    private resumeTimer: ReturnType<typeof setTimeout> | undefined;
    private lastRefreshAt: number = 0;
    private focused: boolean;

    constructor(focused: boolean = true) {
        this.focused = focused;
    }

    /**
     * Begin refreshing every intervalMs. Replaces any previously scheduled work.
     * The first tick happens a full interval from now.
     */
    start(intervalMs: number, onRefresh: () => void): void {
        this.stop();

        if (intervalMs <= 0) {
            return;
        }

        this.intervalMs = intervalMs;
        this.onRefresh = onRefresh;
        this.lastRefreshAt = Date.now();
        this.arm();
    }

    /**
     * Cancel all scheduled work and forget the configured interval.
     */
    stop(): void {
        this.disarm();
        this.intervalMs = 0;
        this.onRefresh = undefined;
    }

    /**
     * Report a window focus change. Suspends ticking while unfocused and resumes
     * on the remainder of the current period when focus returns.
     */
    setFocused(focused: boolean): void {
        if (focused === this.focused) {
            return;
        }

        this.focused = focused;

        if (focused) {
            this.arm();
        } else {
            this.disarm();
        }
    }

    /** Whether a tick is currently scheduled. */
    isScheduled(): boolean {
        return this.intervalTimer !== undefined || this.resumeTimer !== undefined;
    }

    private arm(): void {
        if (this.isScheduled() || !this.onRefresh || this.intervalMs <= 0 || !this.focused) {
            return;
        }

        const elapsed = Date.now() - this.lastRefreshAt;
        const remaining = Math.max(0, this.intervalMs - elapsed);

        this.resumeTimer = setTimeout(() => {
            this.resumeTimer = undefined;
            this.fire();

            if (this.onRefresh && this.intervalMs > 0) {
                this.intervalTimer = setInterval(() => this.fire(), this.intervalMs);
            }
        }, remaining);
    }

    private disarm(): void {
        if (this.intervalTimer) {
            clearInterval(this.intervalTimer);
            this.intervalTimer = undefined;
        }
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = undefined;
        }
    }

    private fire(): void {
        this.lastRefreshAt = Date.now();
        this.onRefresh?.();
    }
}
