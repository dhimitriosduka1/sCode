# Changelog

All notable changes to the SLURM Cluster Manager extension will be documented in this file.

## [1.1.0] - 2026-02-06

### Added
- **Cancel All Jobs**: New toolbar button to cancel all active jobs with confirmation prompt
- **Advanced Job Array Cancellation**: Flexible options for cancelling job arrays:
  - Cancel entire job array
  - Cancel by range (e.g., `0-10`)
  - Cancel with step notation (e.g., `0-20:2` for every 2nd job)
  - Cancel specific indices (e.g., `1,3,5,7`)
- **Smart Validation**: 
  - Validates input against actual SLURM array bounds
  - Detects duplicate indices in comma-separated lists
  - Warns when cancelling >100 jobs at once
  - Shows actual array range in the input prompt

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
