# Changelog

All notable changes to the SLURM Cluster Manager extension will be documented in this file.

## [Unreleased]

### Added
- **Direct SSH Remote Slurm Support**: Added an SSH connection mode that runs Slurm commands on a remote server through the system OpenSSH client while keeping local mode as the default.
- **Remote Connection Commands**: Added commands to configure the Slurm connection mode and test the active Slurm connection.
- **Remote Log Opening**: Added read-only remote stdout/stderr opening for SSH mode with file metadata checks and a configurable size limit.
- **Connection Setup UX**: Added a clickable SLURM status bar connection item for switching clusters and seeing connection health, plus direct "Connect with SSH" actions from connection failure messages.
- **Multiple Cluster Profiles**: Added named local/SSH cluster profiles and a switcher command for moving between Slurm clusters without editing settings manually.

### Security
- **Structured Command Execution**: Slurm commands now go through a local/SSH executor abstraction using structured arguments instead of shell-string command construction.
- **SSH Safety Defaults**: SSH mode uses `BatchMode=yes`, keeps OpenSSH host-key verification enabled, rejects unsafe command arguments, and does not collect or store SSH passwords.
- **Explicit Remote Paths**: SSH mode requires absolute remote paths for submission and log opening; uploads and local-to-remote path mapping are intentionally not supported in this first secure version.

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
