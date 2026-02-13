# Changelog

All notable changes to the SLURM Cluster Manager extension will be documented in this file.

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
- **Cluster Dominator**: The fun "Cluster Dominator" status is now always visible at the top of the job list, even when you have no active jobs

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
