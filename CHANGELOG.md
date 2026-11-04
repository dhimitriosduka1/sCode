# Changelog

All notable changes to the SLURM Cluster Manager extension will be documented in this file.

## [Unreleased]

### Changed
- **Active Jobs Refresh Interval**: The Active Jobs toolbar's Toggle Auto Refresh button is replaced by a watch icon (`$(watch)`) that opens the same interval picker as GPU Partition Usage: every 10s, 30s, 1, 2 or 5 min, Off, or a custom interval, instead of requiring a trip to Settings. Picking an interval also turns auto-refresh on; Off turns it off and keeps the interval for next time. The status bar item still toggles auto-refresh with one click. The watch icon sits at the end of the toolbar, where it is in GPU Partition Usage.
- **Leaner Active Jobs Toolbar**: Removed the Submit Job button from the Active Jobs toolbar to free up space. Submitting from an open script via the editor title bar ▶ button is unchanged, and Submit Job remains available from the Command Palette.

### Added
- **Slurm Not Available Panel**: When Slurm isn't installed on the machine VS Code runs on (no `squeue` on the PATH), the SLURM Cluster sidebar now shows only a "Slurm Not Available" panel saying so, instead of five panels with nothing to show. While that check runs at startup, the same panel says it is checking, so the job views never appear only to vanish again. The panel lists the hosts in `~/.ssh/config` to connect to instead (following `Include`s, expanding `%h` in `HostName`, and leaving out wildcard patterns and `Match` blocks), grouped by site so a cluster's login nodes sit together: `dais11.mpcdf.mpg.de` and `raven.mpcdf.mpg.de` under `mpcdf.mpg.de`, and hosts without a domain under Other. The largest site comes first, each row shows the user it logs in as, and the tooltip gives the host, user, port and the config file it came from. Its refresh button re-reads the config.
- **Connect to a Cluster over SSH**: Clicking a host in the Slurm Not Available panel (or its Connect button) signs in to it, and every view then shows that cluster: jobs, partitions, history, Hall of Shame. This is for computers that share the cluster's file systems at the same paths, such as a workstation mounting the cluster's home and scratch, for clusters whose login nodes can't host the VS Code server: every path then means the same file on both sides. Connecting checks it by writing a small file into your cluster home folder from here and checking over SSH that the cluster sees it (it is removed straight away), and stops with a message saying why on a computer that doesn't share it. Signing in is left entirely to the system's OpenSSH, so keys, the agent, `~/.ssh/config`, jump hosts and host key checks work as in a terminal, and no password or code passes through the extension. When a key is enough, it connects without a prompt; otherwise a terminal opens to sign in (a password, 2FA, or confirming a new host's fingerprint) and closes once connected. One connection per host is kept open and shared by every command, so nothing signs in twice, even across windows. You are known by the account ssh logs in as (from `ssh -G`, so `User` lines in `Host *` and `Match` blocks count too), which is what your fair share, your Hall of Shame row and `%u` in log paths go by. The status bar shows which host the sidebar is connected to; click it to disconnect, or to cancel a sign-in in progress. A dropped connection, an unreachable host and a host without Slurm each return to the host list saying what happened. The connection closes with the window that opened it. Job logs open from the cluster over the same connection, read-only and without copying them to your machine: stdout and stderr from Active Jobs and Job History, side by side included. Open logs update as the job writes to them, like local files do: they are checked every 5 seconds while the window is in front (every 30 seconds for logs over 10 MB), all in one SSH call. Logs over 10 MB show their last 10 MB with a line saying so, and `~` in log paths is your home on the cluster. Log paths remembered for Job History are kept per cluster, since job IDs repeat across clusters. Scripts in your workspace submit as they do on a login node and run in their folder there, and a job's submit script opens from this computer, editable. The copy of each job's script made at submission is kept per cluster. Its socket lives in a folder only you can open, and it never forwards your agent, X11 or ports. It reuses the existing availability check, so wherever Slurm works it runs nothing extra and stays out of the way, including in mock mode.
- **Wrong GPU Type Warnings**: Submit scripts now underline a requested GPU type that none of the job's partitions has, which Slurm would reject at submission (`--gres=gpu:h200` with `-p a100-long`), as well as GPU requests on partitions without GPUs. The warning names the partitions and the GPU types they do have. The same Slurm rules as the autocomplete decide which partition applies to each line, directives Slurm ignores (below the first command) are skipped, and requests whose partition is unknown or unnamed are left alone. Checked as you type and whenever the background partition refresh brings new data; shown as warnings rather than errors since that data can be a few minutes old.
- **GPU Type Autocomplete**: Submit scripts now suggest GPU types after `--gres=gpu:` and in `--gpus`, `-G`, and `--gpus-per-node`/`-task`/`-socket` values, with each type's idle and installed counts, most idle first. Suggestions are limited to the partitions the request will run in, following Slurm: the script's `#SBATCH` partition (only directives above the first command count, and the last one wins), a `-p` on the same `srun`/`salloc` line, or any partition for an `sbatch` line, which submits another script. This catches requesting a GPU type the partition doesn't have, which leaves a job pending forever, and a partition without GPUs is called out instead of suggesting nothing. Idle counts per type come from the existing GPU Partition Usage queries, now broken down by type for partitions mixing GPU models; with several partitions in play, the best single partition's count is shown, as a job runs in only one.
- **Fair Share Visibility** ([#3](https://github.com/dhimitriosduka1/sCode/issues/3)): Slurm fair share is now visible without dropping into a terminal. Active Jobs gains a header row with your Fair Tree fair share factor, and Hall of Shame rows show each user's factor alongside their GPU usage, so you can compare your standing against the people ahead of you in the queue. Since fair share is tracked per account, users with several accounts see the standing of the account their jobs run under (falling back to their default account, from one `sacctmgr` call per session), not their best one; the Active Jobs row's tooltip lists every account. Sourced from `sshare`, with a single call shared across views and cached for a few minutes; Active Jobs' and Hall of Shame's refresh buttons re-query it.
- **Pending Job Priority Breakdown**: Pending jobs now show their `sprio` priority components in the tooltip — total priority plus the weighted fair share, age, QOS, partition, and job size contributions — and name the component contributing most to that job's priority. `sprio` is only queried when something is actually pending.
- **Fair Share Setting**: Introduced `slurmClusterManager.showFairShare` (default `true`) to disable the fair share rows and skip the `sshare`/`sprio` calls entirely. Clusters without Slurm accounting or the multifactor priority plugin degrade silently, since absent fair share data is a site configuration fact rather than an error.
- **Side-by-Side Log View**: Added an "Open Stdout and Stderr Side by Side" action (`$(split-horizontal)`) next to the existing stdout/stderr buttons on running jobs, opening stdout in the active editor group and stderr in a split beside it. The inline button can be hidden with the new `slurmClusterManager.showOpenLogsSideBySideButton` setting, which leaves the action available from the job's right-click menu. Jobs that merge both streams into a single file open just that one editor.
- **Background Partition Refresh**: GPU Partition Usage now refreshes itself every 5 minutes instead of only on demand, sharing one cached snapshot with partition autocomplete. A scheduled run and the view's refresh button both replace that snapshot, and a manual refresh restarts the schedule. A progress bar shows on the view whenever a refresh runs, and like Active Jobs auto-refresh it pauses while the window is unfocused. A failed refresh keeps the last good data instead of blanking the view. Set the interval (or turn it off) from the new watch icon (`$(watch)`) in the view's toolbar, or with the new `slurmClusterManager.partitionRefreshInterval` setting (minutes, default `5`, `0` = off).
- **Partition Autocomplete**: Submit scripts now suggest partition names as you type them, with each partition's load and idle capacity beside its name and the GPU Partition Usage breakdown in the details panel. GPU partitions come first, ranked on GPU load as in the GPU Partition Usage view, then CPU-only partitions ranked on CPU load (from one `sinfo` call), each group least occupied first and marked by its own icon. When the script already requests GPU types, partitions offering all of them move to the top and the rest are marked (`· no h200`) rather than hidden, so the partition can always be changed to switch hardware. Covers `#SBATCH --partition=`/`--partition `/`-p`/`-p<name>` and unambiguous abbreviations such as `--part=`, the same options on `srun`, `salloc` and `sbatch` lines (but not a launched program's own `-p`), and the `SBATCH_PARTITION`, `SALLOC_PARTITION` and `SLURM_PARTITION` variables. Comma-separated lists complete one slot at a time without repeating partitions already listed. Suggestions come from the same data as GPU Partition Usage, so typing never queries Slurm and the details panel says when that data was fetched. When the data isn't there yet, the list opens right away with a "Loading partitions…" entry and fills in once the data arrives; when there is nothing to suggest, it says so instead of staying closed.

### Fixed
- **Slow Active Jobs With Many Jobs**: Refreshing Active Jobs asked Slurm about each job separately, all at once. On clusters whose controller limits how many requests each user makes (`rl_enable`), the requests beyond the limit waited, so with 20 jobs a refresh took close to a minute. All jobs' details now come from one `squeue` request, which keeps a refresh around a second however many jobs there are; `scontrol` is still asked about any job `squeue` gives no details for, for example on a Slurm version that can't report them. With no jobs queued, nothing beyond the job list is asked. Pending jobs now also show the memory they asked for, where they showed none before, since `squeue` reports what a job requested before it is allocated. A refresh also no longer runs `nvidia-smi`, whose result nothing showed; the GPU row in a job's details comes from Slurm.
- **Views Emptying When Refreshed During a Refresh**: Refreshing Active Jobs or Job History while it was still loading (a second click, an auto-refresh tick, or cancelling a job) emptied the view until another full load had finished, and every further click emptied it again. VS Code runs a view's refreshes one after another, so the first load still showed its result, which was empty because the newer refresh had superseded it. A refresh asked for during a load now waits for it: the load shows what it found, then one more load follows, however many refreshes came in meanwhile, so changes such as a cancelled job still show. Cluster Overview and Hall of Shame work the same way. While a view loads, its refresh button is greyed out, GPU Partition Usage's included; redrawing what a view already has, such as filtering it by a search, leaves the button alone.
- **Logs Reported Missing Right After a Job Starts**: On clusters whose home or scratch is on NFS, opening a log within a minute or so of the job starting could say the file did not exist, if anything on the login node had looked for it before the job wrote it (NFS remembers the miss). A miss is now checked again after re-reading the log's folder, which makes NFS look again; this applies both over SSH and when VS Code runs on the login node.
- **Script Paths and Dependencies Passed to the Shell As Typed**: Submitting a script passed its path to `sbatch` in double quotes, so a path containing `"`, `$` or a backtick failed to submit, or ran part of it as a command, and dependency values (when submitting with a dependency or updating one) were not quoted at all. Both are now quoted so the shell passes them on unchanged.
- **Partition Hover Accuracy and Safety**: Hovering a partition name in a submit script showed different, often too optimistic numbers from GPU Partition Usage: it ran its own `sinfo`/`squeue` queries that missed GPUs requested with `--gpus`/`--gpus-per-node` and counted drained nodes as capacity, and it read `-p a,b` as one partition named `a,b`. It also passed the hovered text into a shell command unescaped, so hovering a crafted partition name could run arbitrary commands. The hover now reads the shared background partition snapshot instead, running no command at all, so its numbers match GPU Partition Usage and autocomplete; it recognises every partition form autocomplete does (abbreviations, `-pname`, `srun` lines, lists, `SBATCH_PARTITION`), covers CPU-only partitions, and calls out names that aren't partitions on the cluster. The panel opens with how old the data is ("Updated 2 min ago") and a refresh button (`$(refresh)`, as in the view toolbars); autocomplete's details panel now opens with the same line instead of ending with the refresh time.

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
