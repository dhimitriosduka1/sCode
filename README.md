# SLURM Cluster Manager

**Manage, monitor, and submit SLURM jobs directly from VS Code.**

SLURM Cluster Manager brings your HPC workflow into your editor: monitor jobs in real time, inspect logs instantly, and take common actions (cancel/hold/pin) without context-switching to a terminal.

![Extension Icon](icon.png)

---

## ✨ Highlights

- **Live job monitoring** in a dedicated sidebar (Running / Pending / Held)
- **Visual progress bars** for time usage (`Elapsed / Time Limit`)
- **Resource overview** (CPUs, memory, nodes)
- **GPU stats** via `nvidia-smi` (when available)
- **One-click actions**: cancel, hold, pin
- **Job history** for recent completed/failed/cancelled jobs
- **Instant log access** for `stdout` / `stderr`

---

## 🚀 Features

### Active Job Management
- **Real-time Monitoring**: View all active jobs at a glance (Running, Pending, Held).
- **Time Awareness**: Smart progress bars show elapsed vs. requested wall time.
- **Resource Stats**: Display allocated CPUs, memory, and node count for each job.
- **GPU Visibility**: Uses `nvidia-smi` to surface GPU utilization and memory usage where supported.
- **One-Click Actions**: Cancel, hold, or pin jobs directly from the UI.
- **Cancel All Jobs**: Quickly cancel all your active jobs with a single click (with confirmation prompt).

### Job Array Management
Smart handling of SLURM job arrays with flexible cancellation options:
- **Cancel entire array**: Remove all jobs in the array at once
- **Cancel by range**: Use `0-10` syntax to cancel indices 0 through 10 (inclusive)
- **Cancel with step**: Use `0-20:2` to cancel every 2nd job (0, 2, 4, ..., 20)
- **Cancel specific indices**: Use `1,3,5,7` to cancel non-contiguous jobs
- **Bounds validation**: Automatically validates against actual array range
- **Safety warnings**: Extra confirmation when cancelling >100 jobs

### Job History & Logs
- **Integrated History**: Browse recent completed, failed, and cancelled jobs (default: last 7 days).
- **Instant Log Access**: Right-click any job (active or historical) to open its `stdout` / `stderr`.
- **Smart Path Resolution**: Automatically resolves log locations from `sbatch` directives and `scontrol` metadata.

### Workflow Integrations
- **Pinning**: Keep critical long-running jobs visible even while filtering or sorting.
- **Search & Filter**: Quickly find jobs by name.

---

## ⚙️ Configuration

Configure the extension via **VS Code Settings** (`Cmd+,` on macOS / `Ctrl+,` on Windows/Linux):

| Setting | Default | Description |
|---|---:|---|
| `autoRefreshInterval` | `30` | Refresh frequency (in seconds). Range: **5s → 1h** |
| `autoRefreshEnabled` | `false` | Auto-start refreshing on window load |
| `confirmCancelJob` | `true` | Ask for confirmation before cancelling a job |

> Tip: If you monitor many jobs, increasing `autoRefreshInterval` reduces SLURM command load.

---

## ✅ Requirements

This extension **must run on a machine with direct access to SLURM commands**.  
In practice, that means you should install it **only on the cluster side** (e.g., a login node / head node / SLURM-accessible node — whichever your site provides), not on your local computer.

Required commands:
- `squeue`
- `scontrol`
- `sacct`
- `sbatch`
- `scancel`

### Important: No Remote Connection (Yet)
At the moment, the extension **cannot connect to a remote cluster by itself**.
It does **not** SSH into a server, tunnel commands, or forward SLURM calls.

✅ **Supported setup:** Run VS Code *on the SLURM-accessible node* (or use **VS Code Remote - SSH** to open a remote VS Code session on that node) and install the extension **on the Remote target**.

🚧 **Remote connection support is work-in-progress (WIP)** and will be added in a future release.

---

## 🤝 Contributing

Contributions are welcome — bug fixes, documentation improvements, and feature requests.

- Report issues / request features: https://github.com/dhimitriosduka1/sCode/issues  
- Pull requests are welcome!

If you’re opening a PR, please include:
- A short description of the change and why it helps
- Screenshots/GIFs for UI updates (when applicable)

---

## 📄 License

MIT — see [LICENSE](LICENSE).

---

<p align="center">
  If this extension helps you, consider giving it a ⭐ on <a href="https://github.com/dhimitriosduka1/sCode">GitHub</a>!
</p>

<p align="center">
  Made with ❤️ by <a href="https://github.com/dhimitriosduka1">Dhimitrios Duka</a> with <b>Google Antigravity</b>
</p>