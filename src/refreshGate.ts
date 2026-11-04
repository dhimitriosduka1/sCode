/**
 * One load of a view at a time.
 *
 * VS Code runs a view's refreshes one after another, so a refresh asked for
 * while the view loads (a click on refresh, an auto-refresh tick, a cancelled
 * job) waits behind the load anyway, and a load whose data was dropped meanwhile
 * could only show an empty view until the next load finished. Instead the load
 * finishes and shows its result, and one more follows to pick up what changed
 * since it started, however many refreshes were asked for in between.
 *
 * Kept free of vscode imports so it can be unit tested directly.
 */
export class RefreshGate<T> {
    private loading: Promise<T> | undefined;
    private reloadAfterLoad = false;
    /** The view has no data, or it was dropped: the next load fetches it. */
    private stale = true;

    /**
     * `reload` drops the view's data and has VS Code load the view again.
     * `onRefreshingChange` is told when a load that fetches data starts, and
     * when the last of them is done, e.g. to disable the view's refresh button;
     * loads that only redraw what the view has are left out.
     */
    constructor(
        private readonly reload: () => void,
        private readonly onRefreshingChange: (refreshing: boolean) => void = () => undefined,
    ) {}

    /** Reloads the view now, or once the load in progress is done. */
    refresh(): void {
        if (this.loading) {
            this.reloadAfterLoad = true;
            return;
        }
        this.stale = true;
        this.reload();
    }

    /** Runs the view's load, or joins the one in progress. */
    load(work: () => Promise<T>): Promise<T> {
        if (!this.loading) {
            const refreshing = this.stale;
            this.stale = false;
            if (refreshing) {
                this.onRefreshingChange(true);
            }
            this.loading = work().finally(() => {
                this.loading = undefined;
                if (this.reloadAfterLoad) {
                    // Still refreshing: the load this reload brings is done when it is
                    this.reloadAfterLoad = false;
                    this.stale = true;
                    this.reload();
                } else if (refreshing) {
                    this.onRefreshingChange(false);
                }
            });
        }
        return this.loading;
    }
}
