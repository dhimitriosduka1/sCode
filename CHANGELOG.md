# Changelog

All notable changes to the SLURM Cluster Manager extension will be documented in this file.

## [1.3.0] - 2026-02-26

### Added
- **Quick Submit Button**: A ▶ button appears in the editor title bar when viewing a SLURM script (any file containing `#SBATCH`). One click submits the script immediately. A brief status bar notification confirms the submission.
- **Partition Hover Stats**: Hover over a partition name in `#SBATCH --partition=` or `#SBATCH -p` to see real-time GPU usage, running/pending jobs, and node availability in a rich tooltip with a visual usage bar.
- **Hoverable Partition Underline**: Partition names in SLURM scripts get a dotted underline to indicate they're interactive.

## [1.2.0] - 2026-02-26

### Added
- **Hall of Shame**: New sidebar leaderboard showing the top cluster resource hogs, ranked by GPU allocation and running job count. Only fetches data on manual refresh — no background polling.
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
- Job history browser (last 7 days)
- Pin important jobs to keep them visible
- Search and filter jobs by name
- One-click access to stdout/stderr files
- Cancel jobs directly from the UI
- Auto-refresh with configurable interval
- Job submission
