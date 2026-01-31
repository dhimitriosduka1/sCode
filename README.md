# SLURM Cluster Manager

A VS Code extension for managing SLURM jobs without leaving your editor.

If you've ever gotten tired of switching between your code and a terminal just to check if your job is still running, or to find where SLURM dumped your stdout file this time — this is for you.

## Features

### Active Jobs View
See all your running and pending jobs in the sidebar. Each job shows:
- Job name, state, and partition
- Time elapsed vs. time limit (with a progress bar)
- GPU and memory allocation
- Start time

Right-click any job to open its stdout/stderr files or cancel it.

### Job History
Browse your recently completed jobs (last 7 days by default). Search through them, paginate if you have a lot, and quickly access output files from finished jobs.

### Pin Jobs
Keep track of important jobs by pinning them. Pinned jobs stay visible at the top even as your other jobs come and go.

### Submit Jobs
Submit batch scripts directly from the explorer. Right-click on a `.sh` file or use the submit button in the jobs view.

### Auto-Refresh
Enable auto-refresh to keep your job list updated without manual refreshing. Configurable interval (5s to 1 hour).

## Requirements

- VS Code 1.85.0 or later
- Access to a SLURM cluster (the extension needs `squeue`, `scontrol`, `sacct`, and `sbatch` commands)

## Installation

Install from the VS Code Marketplace, or:

```bash
code --install-extension slurm-cluster-manager-x.x.x.vsix
```

## Extension Settings

- `slurmClusterManager.autoRefreshInterval`: How often to refresh (in seconds, default: 30)
- `slurmClusterManager.autoRefreshEnabled`: Start with auto-refresh on/off (default: off)
- `slurmClusterManager.confirmCancelJob`: Ask before cancelling jobs (default: on)

## Usage

1. Open the SLURM Cluster panel from the activity bar (server icon)
2. Your active jobs appear automatically
3. Click the refresh button or enable auto-refresh
4. Use the search icon to filter jobs by name
5. Right-click jobs for actions (open output, cancel, pin)

## Contributing

Found a bug? Have a feature idea? Open an issue on GitHub.

## License

MIT