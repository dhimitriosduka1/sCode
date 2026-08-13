# Changelog

All notable changes to the SLURM Cluster Manager extension will be documented in this file.

## [1.6.0] - 2026-08-13

### Added
- **Cluster Maintenance Warnings**: Active Jobs, GPU Partition Usage, and Cluster Overview now surface a warning row when a Slurm reservation flagged `MAINT` is upcoming or in progress, showing a countdown ("Cluster maintenance starts in 2d") or an in-progress notice, with reservation name/nodes/start/end in the tooltip. Sourced from `scontrol show reservation`, so it works on any cluster that announces downtime this way.
- **Expandable GPU Partition Rows**: Each row in GPU Partition Usage is now collapsible, revealing GPU counts, node counts, GPU types, and job counts as child rows. The breakdown text is shared with the row tooltip so both stay in sync.
- **Job History Path Caching Tests**: Added unit test suites verifying path resolution, placeholder retention, and array task base ID fallback lookups.
- **Automatic Extension Activation**: Configured the extension to activate automatically on VS Code startup (`onStartupFinished`), enabling background features (status bar, auto-refresh, notification polling) to start immediately without requiring manual interaction.
- **Log Preview Customization**: Introduced the `slurmClusterManager.openLogFileInPreview` configuration setting, allowing users to choose whether to open stdout/stderr log files in VS Code's preview mode (reuses the same tab) or as permanent editor tabs.
- **Job Dependency Management**: Added "Update Dependency..." inline action (`$(link)`) on all pending jobs. Supports adding a new dependency (select from active jobs or enter a custom Job ID), updating an existing one, or clearing it entirely. The current job is automatically excluded from the picker to prevent self-dependency. Pin/unpin for pending jobs is now accessible via right-click only, freeing the inline slot for this action.

### Removed
- **Pin/Unpin feature**: Removed the ability to pin jobs to a dedicated "Pinned" category at the top of the tree view. The `pinnedJobsCache.ts` module and all associated commands (`slurmJobs.pinJob`, `slurmJobs.unpinJob`) have been deleted.

### Fixed
- **Auto-Refresh Burst On Window Focus**: Fixed a storm of `squeue`/`scontrol` calls firing all at once when VS Code regained focus after being minimized or backgrounded. Auto-refresh now suspends while the window is unfocused and resumes on the remainder of the current interval, so returning triggers a single refresh instead of one per elapsed tick. Additionally, concurrent tree renders now share a single in-flight fetch (the previous `isLoading` guard was never read), cluster hog stats are cached alongside the job list instead of re-queried on every render, and the `which squeue` availability probe is resolved once per session.
- **Missing Configuring (CF) Jobs**: Fixed jobs in the CF (Configuring) state — including job arrays — not appearing anywhere in the Active Jobs panel. The state was absent from the panel's status categories, so squeue reported these jobs but the tree view silently dropped them. CF jobs now show up under the "Running" category.
- **GPU Partition Usage Accuracy**: GPU Partition Usage now sources allocated GPU counts from `scontrol show node`'s `AllocTRES` field instead of `squeue`'s GRES field. This correctly counts GPUs requested via `--gpus`/`--gpus-per-node` (not just `--gres`), and correctly attributes allocations to every partition that shares the same physical nodes (e.g. `gpu` / `gpudev`).
- **GPU Partition Double-Counting**: Fixed the cluster-wide summary row in GPU Partition Usage inflating total GPU counts when overlapping partitions shared the same physical nodes. Cluster-wide totals are now derived from unique nodes rather than summed per-partition.
- **Large Cluster Buffer Overflow**: Fixed `scontrol`/`sinfo`/`squeue` commands silently failing (reporting 0 allocated GPUs) on large clusters (1500+ nodes) by increasing the exec buffer to 32MB for all cluster-wide commands.
- **Job History Log Path Resolution**: Fixed a bug where stdout/stderr paths occasionally disappeared or showed as 'N/A' in the Job History view for jobs that completed quickly or when auto-refresh was disabled. Resolved this by (1) pre-caching job paths immediately upon submission, (2) caching paths in their raw placeholder format instead of fully expanded formats (allowing node-name `%N` and task-ID `%a` to be resolved dynamically on history lookup), and (3) adding base job ID fallbacks for array task lookups in the cache.
- **Clearing Job Dependencies**: Fixed "Clear Dependency" failing to remove a pending job's dependency. The update was sent as `scontrol update Dependency=none`, which Slurm treats as a literal dependency type rather than a reset; it now sends an empty `Dependency=`.
- **Array Throttle Icon**: Replaced the `$(hash)` icon on the "Update Array Throttle..." inline action with `$(symbol-number)`, which is reliably supported across VS Code versions.

## [1.5.0] - 2026-06-27

### Added
- **Copy Job ID Action**: Added inline and context-menu copy actions (`$(copy)`) to quickly copy the master base Job ID (excluding array ranges or indices) to the system clipboard for active jobs and history jobs.
- **Job Array Dependency Support**: Resolved bracket range notations in pending job arrays during `scontrol show job` queries, successfully restoring dependency tracking and status icons (`🔗`).
- **Interactive Job Dependency Submission**: Added a dedicated "Submit with Dependency" workflow (`$(link)`) next to the main Play button in the editor titles. The main Play button submits jobs immediately (preserving the fast, 1-click UX), while the Dependency button guides users through step-by-step active job selection, custom ID inputs, and dependency types (`afterok`, `afterany`, `after`, `afternotok`) directly and efficiently.
- **Dependency Prompt Configuration**: Introduced `slurmClusterManager.submitDependencyBehavior` setting with `"prompt"` (default) and `"never"` options to customize or bypass the dependency prompt entirely.
- **Optional Resource Hogs**: Introduced `slurmClusterManager.showResourceHogs` setting with `true` (default) and `false` options to skip fetching and displaying Job Hog and GPU Gobbler stats in the Active Jobs view, saving compute/network resources on every refresh.
- **Job Array Throttle Modification**: Added "Update Array Throttle..." inline action (hashtag icon `$(hash)` on hover) to change the concurrent task throttle limit (`ArrayTaskThrottle`) of active job arrays, only visible on the main job array item (with bracket notations) and not individual running tasks.
- **Hold and Release Pending Jobs**: Added "Hold Job" (lock icon `$(lock)` on hover) and "Release Job" (unlock icon `$(unlock)` on hover) actions for pending jobs. When a pending job is active, users can freeze it using the hold button. If it is already held, they can release it to the pending queue using the unlock button. Validated in both mock mode and scontrol execution.
- **Bulk Hold/Release on Pending Header**: Added "Hold All Pending Jobs" (`$(lock)`) and "Release All Pending Jobs" (`$(unlock)`) inline actions and context menu options directly on the `"Pending (x)"` category header row (visible only when there is at least 1 pending job).
- **Pin/Unpin Pending Jobs**: Added pin and unpin inline actions for pending jobs (all variants: held, array, pinned), consistent with the existing behaviour for running jobs.
- **Held Job Visual Indicator**: Held pending jobs now display a distinct lock icon (orange) in the tree view, making their frozen state immediately visible without needing to expand the job details.
- **Cancel All Running Jobs**: Added a "Cancel All Running Jobs" inline button (bin icon `$(trash)`) and context menu option directly on the `"Running (x)"` category header row (visible only when there is at least 1 running job) to safely batch cancel all running jobs with a double-confirmation modal.

### Improved
- **Optimized sacct Performance**: Configured `sacct` history queries to run with the `-X` flag (fetching only parent jobs/steps) and increased command execution buffer size limit to 16MB to prevent buffer overflow crashes on large active clusters.
- **Job History File Path Descriptions**: Display resolved stdout/stderr log file paths as descriptions directly next to log items in the Job History sidebar tree view.

### Fixed
- **GPU Double-Counting**: Fixed a bug in GRES resource parsing where requesting a generic GPU count alongside a specific GPU type resulted in twice the actual allocated count (e.g. showing `16x B200` instead of `8x B200`).
- **Multi-node GPU accounting**: Hall of Shame, Cluster Overview, GPU hog metrics, GPU Partition Usage, and active job details now multiply per-node GPU requests by allocated node count, so jobs using 4 nodes with 4 GPUs each are counted as 16 GPUs instead of 4.

## [1.4.0] - 2026-04-28

### GPU Usage Insights
- **GPU Partition Usage**: Added a GPU-only partition view for comparing Slurm partitions before submitting jobs. Partitions are sorted from least used to most used by allocated GPU share, pending pressure, idle GPUs, running jobs, and name.
- **Cluster Overview**: Added an account-level GPU usage view showing which Slurm accounts are using the most GPUs, including top users, GPU type breakdowns, cluster-share bars, and refresh timestamps.
- **Hall of Shame Overhaul**: Reworked Hall of Shame into a GPU-only leaderboard that shows rows directly, excludes CPU-only jobs and users, highlights your own row, and supports a configurable top-user count.
- **GPU Context Everywhere**: Hall of Shame and Cluster Overview now show Slurm account context, GPU type breakdowns, and cluster GPU share bars.
- **GPU Partition Accuracy**: GPU Partition Usage now ignores CPU-only partitions and uses available GPU capacity, so down or draining nodes do not make a partition look more usable than it is.

### Job Management
- **Human-readable Pending Reasons**: Pending jobs now show readable explanations for Slurm reason codes like `Resources`, `Priority`, `Dependency`, QOS limits, and association limits.
- **Cancel All Pending Jobs**: Added a Pending category context action to cancel all pending jobs while leaving running jobs untouched.

### Job History and Logs
- **Job History Refresh Summary**: Job History now shows when data was last fetched and summarizes the active lookback range.
- **Job History Date Groups**: Historical jobs are grouped by completion date with compact end-time and elapsed-time labels.
- **Configurable Job History Range**: Added a Job History toolbar action for changing the `sacct` lookback window.
- **Stdout/Stderr Path Handling**: Output paths now handle `scontrol` metadata more robustly, including relative paths resolved against `WorkDir`, `~`, quoted values, Slurm octal escapes, common filename placeholders, job arrays, unavailable `(null)` paths, and unresolved pending-node placeholders.
- **Job History Output Lookup**: Historical stdout/stderr lookup now uses cached active-job paths when safe, falls back to `scontrol` when available, and avoids caching unresolved output paths.

### UI and Documentation
- **Consistent Tooltips**: Tree and partition-hover tooltips now use the same readable title, summary, and bullet-list style.
- **Refresh Awareness**: Hall of Shame, Cluster Overview, and Job History now show last-refreshed timestamps so users know how fresh the data is.
- **README Product Screenshots**: README now includes updated product screenshots for the full sidebar, Active Jobs, Job History, and GPU partition submission workflow.
- **Extension Icon**: Replaced the old text-heavy icon with a cleaner SLURM/GPU cluster mark.

## [1.3.0] - 2026-02-26

### Added
- **Quick Submit Button**: A ▶ button appears in the editor title bar when viewing a SLURM script (any file containing `#SBATCH`). One click submits the script immediately. A brief status bar notification confirms the submission.
- **Partition Hover Stats**: Hover over a partition name in `#SBATCH --partition=` or `#SBATCH -p` to see real-time GPU usage, running/pending jobs, and node availability in a rich tooltip with a visual usage bar.
- **Hoverable Partition Underline**: Partition names in SLURM scripts get a dotted underline to indicate they're interactive.

## [1.2.0] - 2026-02-26

### Added
- **Hall of Shame**: New sidebar view showing the top cluster GPU resource hogs. Only fetches data on manual refresh — no background polling.
- **GPU Hog Tracking**: A separate "VRAMpire" indicator at the top of the job list shows the user with the most GPUs allocated across running jobs, alongside the existing job count hog.
- **Batch Cancel via Checkboxes**: Select multiple jobs using checkboxes, then cancel them all at once. The "Cancel All" button becomes "Cancel Selected" when jobs are checked. Selections persist across refreshes.
- **Job Dependencies**: Jobs with dependencies now show a 🔗 indicator and the dependency details (e.g., `afterok:12345`) in the expanded job view.

### Improved
- **Job Array Cancel UX**: The cancel dropdown (cancel pending / cancel specific / cancel entire array) now only appears for **pending** job array tasks. Running job array tasks are cancelled directly like any regular job, fixing an issue where already-dispatched indices couldn't be cancelled.
- **Streamlined Pending Jobs**: Pending jobs now hide irrelevant details (Nodes, Elapsed, stdout, stderr) and show estimated start time and dependency info instead.

## [1.1.0] - 2026-02-13

### Added
- **Cancel All Jobs**: New toolbar button to cancel all active jobs with confirmation prompt
- **Job Array Cancellation**: Smart handling of job arrays with two clear options:
  - Cancel entire job array at once
  - Cancel specific job(s) with flexible input formats:
    - Single index: `3`
    - Range: `0-10`
    - Step: `0-20:2` (automatically expanded for `scancel` compatibility)
    - List: `1,3,5,7`
- **Smart Validation**:
  - Validates input against actual SLURM array bounds (handles complex formats like `0,2,4,6-10`)
  - Detects duplicate indices in comma-separated lists
  - Warns when cancelling >100 jobs at once
  - Shows actual array range in the input prompt
- **Fun Job Titles**: The fun status at the top of the job list now randomly picks from five titles — 🐷 Job Hog, 🔥 Cluster Dominator, 🤗 CUDA Cuddler, 😋 Node Nom-Nom, and 🧛 VRAMpire — and is always visible, even when you have no active jobs

## [1.0.0] - 2026-01-31

### Added
- Active job monitoring with real-time status updates
- Visual progress bars showing elapsed vs. time limit
- GPU visibility via `nvidia-smi` integration
- Job History browser (last 7 days)
- Pin important jobs to keep them visible
- Search and filter jobs by name
- One-click access to stdout/stderr files
- Cancel jobs directly from the UI
- Auto-refresh with configurable interval
- Job submission
