# Handover: Active Jobs is slow over SSH

You're running on a login node of the cluster where the problem shows up. Your job is to find
out **where the time goes** when the extension refreshes, using real Slurm here, and then fix the
biggest cause. Measure before changing anything.

## The problem

The extension can now run Slurm commands from a laptop over SSH (branch `feat/ssh-transport`).
On this cluster, with **41 jobs** in the queue, Active Jobs takes a long time to show its data.
Two fixes are already in and **didn't solve it**:

1. Job details are batched: one `sh -c` script runs `scontrol show job` for every job, instead
   of one SSH command per job.
2. Job details are kept between refreshes: `scontrol` only runs for new jobs and jobs whose
   state or nodes changed. A refresh with an unchanged queue runs no `scontrol` at all.

So the time is going somewhere else. Suspects, most likely first:

1. **Cluster-wide queries on the Active Jobs refresh path.** After your own jobs, the view waits for
   the badges for the top job and GPU users (`squeue --state=R` over *every* running job on the
   cluster, on every refresh), then for fair share and priority (`sprio`, and `sshare -a` over
   every association every 5 minutes). On a big, busy cluster these can each take seconds, and
   they run one after another.
2. **Shell startup on the login node.** Over SSH every command starts the user's shell, which reads
   its startup files (`~/.bashrc`: module system, conda, and so on). A slow `.bashrc` is paid
   on every command.
3. **Large answers competing for the connection.** At startup and every 5 minutes, GPU Partition
   Usage runs `scontrol show node`, `sinfo -N`, and `squeue` over the whole cluster. These can be
   megabytes. At most 8 commands run at once over the shared connection, so Active Jobs' commands
   can wait behind them.
4. **The first load's `scontrol` loop.** It runs one `scontrol show job` after another inside one
   shell.
5. **The extension itself.** For example, auto-refresh firing again before a refresh finishes.

## Repository state

- Branch `feat/ssh-transport`, from `main`. **Uncommitted work**, so check `git status` first.
- Build and test: `npm ci`, then `rm -rf out && npm test`. Stale files in `out/` break the tests,
  so always remove it first. Expect 360 passing.
- Where commands are built:
  - `src/slurmService.ts`: every Slurm command. `getJobs` has the batching and the kept
    details (`knownJobDetails`, `fetchJobDetails`, `getJobDetailOutputs`,
    `SCONTROL_SHOW_JOBS_SCRIPT`).
  - `src/slurmJobProvider.ts` → `loadRootItems`: the order the Active Jobs refresh awaits things in.
- How commands run:
  - `src/sshConnection.ts`: commands over SSH. The `MAX_CONCURRENT_COMMANDS = 8` limit, a 2-minute
    timeout, quoting.
  - `src/clusterConnection.ts`: picks local or SSH, the login terminal, a keepalive every 5 minutes.
  - `src/slurmCommandRunner.ts`: the local runner (`execFile`, no shell).
- `src/partitionDataStore.ts`: the GPU Partition Usage data, refreshed every 5 minutes.

## What one Active Jobs refresh runs, in order

Each numbered step waits for the one before it:

1. `squeue --version` (first time only)
2. In parallel:
   - `id -un` (first time only), then `squeue -u <user> --noheader --format=%i|%j|%t|%M|%P|%N|%l|%S|%r|%a|%E`,
     then the batched `scontrol` script, only for new or changed jobs.
   - `scontrol show reservation`
3. `squeue --noheader --state=R --format=%u|%D|%b`, over **all users** (the top-user badges; off with `showResourceHogs`)
4. In parallel:
   - `sshare -a -n -P -o Account,User,FairShare`: **all associations**, kept 5 min, re-run on a manual refresh
   - `sacctmgr -n -P show user <user> format=DefaultAccount`: once per session
   - `sprio -u <user> -h -o %i|%Y|%A|%F|%J|%P|%Q`: only when something is pending

Other views, when they're open, add:
- **Cluster Overview / Hall of Shame:**
  - `squeue --noheader --state=R --format=%u|%a|%D|%b` (all users), once per view
  - `sshare`
  - `scontrol show reservation`
- **GPU Partition Usage**, at startup and every 5 minutes:
  - `sinfo -N --noheader --format=%N|%P|%T|%G`
  - `scontrol show node`
  - `squeue --noheader --format=%P|%T` (all jobs)
  - `sinfo --noheader --format=%P|%C`
- **Job History:** `sacct -X -u <user> --starttime=<7 days ago> --noheader --parsable2 --format=JobID,JobName,State,ExitCode,Start,End,Elapsed,Partition,NodeList,AllocCPUS,MaxRSS`

## Step 1: time every command here

Save this as `profile-slurm.sh` outside the repo and run it on the login node. It runs each
command exactly as the extension does and reports wall time and the size of the answer.

```bash
#!/usr/bin/env bash
# Times each Slurm command the extension runs, as it runs them, with the size of each answer.
set -u
user=$(id -un)
since=$(date -d '7 days ago' +%F)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

measure() {
    local label=$1; shift
    local start end status
    start=$(date +%s%N)
    "$@" >"$tmp" 2>/dev/null
    status=$?
    end=$(date +%s%N)
    printf '%-32s %7d ms %10d bytes  exit %d\n' "$label" $(( (end - start) / 1000000 )) "$(wc -c <"$tmp")" "$status"
}

echo "login shell: $SHELL"
measure 'shell startup ($SHELL -c true)' "$SHELL" -c true
measure 'sourcing ~/.bashrc' bash -c 'source ~/.bashrc'

measure 'squeue --version'          squeue --version
measure 'id -un'                    id -un
measure 'my jobs (squeue -u)'       squeue -u "$user" --noheader '--format=%i|%j|%t|%M|%P|%N|%l|%S|%r|%a|%E'

# Job IDs as the extension asks scontrol for them: a pending array's base ID
ids=$(squeue -u "$user" -h -o %i | sed -E 's/^([0-9]+)_?\[.*/\1/' | sort -u)
if [ -n "$ids" ]; then
    measure 'one job (scontrol)'    scontrol show job "$(echo "$ids" | head -1)"
    # shellcheck disable=SC2086
    measure "$(echo $ids | wc -w) jobs, batched" sh -c 'marker=$1; shift; for id in "$@"; do printf "%s %s\n" "$marker" "$id"; scontrol show job "$id" 2>/dev/null; done; true' sh @@marker $ids
fi

measure 'reservations'              scontrol show reservation
measure 'top users (squeue all R)'  squeue --noheader --state=R '--format=%u|%D|%b'
measure 'leaderboard (squeue all R)' squeue --noheader --state=R '--format=%u|%a|%D|%b'
measure 'fair share (sshare -a)'    sshare -a -n -P -o Account,User,FairShare
measure 'default account'           sacctmgr -n -P show user "$user" format=DefaultAccount
measure 'priority (sprio -u)'       sprio -u "$user" -h -o '%i|%Y|%A|%F|%J|%P|%Q'
measure 'nodes (sinfo -N)'          sinfo -N --noheader '--format=%N|%P|%T|%G'
measure 'nodes (scontrol show node)' scontrol show node
measure 'queue by partition'        squeue --noheader '--format=%P|%T'
measure 'CPU load (sinfo)'          sinfo --noheader '--format=%P|%C'
measure 'history (sacct, 7 days)'   sacct -X -u "$user" --starttime="$since" --noheader --parsable2 \
    --format=JobID,JobName,State,ExitCode,Start,End,Elapsed,Partition,NodeList,AllocCPUS,MaxRSS
```

Run it two or three times, since the first run warms caches. A command that takes a second or
more, or answers with megabytes, is a suspect.

## Step 2: time the extension's own code here

This runs the service the way Active Jobs does, against real Slurm and without SSH, and logs every
command it starts. Run it from the repo root after `npm ci && rm -rf out && npm run compile`.

```js
// profile-refresh.js (keep it outside src/)
const { SlurmService } = require('./out/slurmService');
const { localCommandRunner } = require('./out/slurmCommandRunner');

const log = [];
const runner = async (argv, options) => {
    const start = Date.now();
    try {
        const result = await localCommandRunner(argv, options);
        log.push({ ms: Date.now() - start, bytes: result.stdout.length, command: argv.slice(0, 4).join(' ') });
        return result;
    } catch (error) {
        log.push({ ms: Date.now() - start, bytes: 'failed', command: argv.slice(0, 4).join(' ') });
        throw error;
    }
};
const service = new SlurmService(undefined, undefined, runner, () => false);

async function time(label, work) {
    const start = Date.now();
    await work();
    console.log(`${label}: ${Date.now() - start} ms`);
}

// What loadRootItems in src/slurmJobProvider.ts awaits, step by step
async function activeJobsRefresh() {
    await time('  1. my jobs + reservations', () => Promise.all([service.getJobs(), service.getMaintenanceWindows()]));
    await time('  2. top-user badges', () => service.getClusterHogs());
    await time('  3. fair share + priority', () => Promise.all([
        service.getFairShare(), service.getUsername(), service.getDefaultAccount(), service.getJobPriorityFactors(),
    ]));
}

(async () => {
    await time('availability', () => service.getAvailability());
    await time('Active Jobs, first load', activeJobsRefresh);
    await time('Active Jobs, refresh (details kept)', activeJobsRefresh);
    service.invalidateFairShareCache();
    await time('Active Jobs, manual refresh (sshare again)', activeJobsRefresh);
    await time('GPU partitions', () => Promise.all([service.getPartitionUsage(), service.getCpuPartitionUsage()]));
    await time('Job History', () => service.getJobHistory(7));
    console.table(log);
})();
```

Over SSH, each command also costs a round trip and a shell start. Add those using the numbers from
Step 3.

## Step 3: what the user measures on the laptop

Claude on the cluster can't see the laptop's side, so the user runs these there with the extension
connected. The extension's connection socket is the one file in its socket folder:

```bash
host=raven   # the host picked in SSH Targets
# macOS:
sock=$(ls -d "${TMPDIR%/}/scode-$(id -u)"/* | head -1)
# Linux:
# sock=$(ls -d "$XDG_RUNTIME_DIR/scode"/* | head -1)

# One command over the extension's connection: round trip plus shell start
time ssh -S "$sock" -o ControlMaster=no -o BatchMode=yes -T -- "$host" true
time ssh -S "$sock" -o ControlMaster=no -o BatchMode=yes -T -- "$host" squeue --version
```

If `true` alone takes hundreds of milliseconds, shell startup or the network is a big part of it.

## What to deliver

1. A table: each command, its time and size on the cluster, and how many times one refresh runs it.
   Add the per-command SSH cost from Step 3.
2. The biggest cause, backed by those numbers.
3. A fix for it, with tests: `rm -rf out && npm test` must pass.

Some fixes to consider, depending on what the numbers show:
- **Don't wait for the top-user badges or fair share** before showing the jobs: render the jobs
  first, then add those rows when they arrive.
- **Refresh cluster-wide data less often than your own jobs,** with its own interval, as fair share
  already does with its 5-minute cache.
- **Run one `squeue --state=R` for the badges, Cluster Overview and Hall of Shame,** instead of one
  per view.
- **Split the first load's `scontrol` loop into a few parallel batches** (up to 8).
- **If shell startup dominates,** say so: that's the user's `.bashrc` (a guard such as
  `[[ $- == *i* ]] || return` near its top skips it for non-interactive commands). Don't work around
  it in the extension without asking.

## Ground rules

- Measure first, and change one thing at a time.
- Keep the UI minimal: fold features into existing views and show the fewest values that answer the question.
- Don't commit or push unless the user asks. Never add Claude as an author or co-author of a commit.
- Never commit a `package.json` version change. Releases are published by hand.
- Before handing back, make sure `git status` shows only the changes you meant to make.
