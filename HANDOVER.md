# Handover: verify the implementation against a real Slurm cluster

You are picking this up on a machine with real Slurm (`sinfo`, `squeue`, `scontrol`,
`sshare`, `sprio`, `sacctmgr`, `sbatch`). Everything below was built and tested on a
laptop **without Slurm**, using mock data and unit tests that feed the parsers
hand-written command output. Your job is to check that the assumptions about real
Slurm output and behaviour hold, and fix what doesn't.

## 0. Get the code into the state it was handed over in

The work is on the temporary branch **`wip/cluster-verification`** (branched from `main`).
It contains, on top of `origin/main`:

- `7edb15e` feat: add GPU type autocomplete and wrong GPU type warnings
- `a55dd53` fix: read partition hover stats from the shared snapshot
- a fair share fix commit (applicable account, tooltip, refresh re-queries `sshare`)
- this handover file

```bash
git fetch origin
git switch wip/cluster-verification
```

`package.json` on the laptop carries a local version bump (`1.6.x`) that is **never**
committed; the branch has the real version.

```bash
npm ci
npm test            # compiles to out/ and runs node:test; expect ~287 passing
```

Needs Node 18+ (CI uses 22). If `out/` has stale files from deleted sources, `rm -rf out`
first: the test glob runs every `out/test/*.test.js`.

## 1. Project in one paragraph

VS Code extension "SLURM Cluster Manager" (`slurm-cluster-manager`). All Slurm access
goes through `src/slurmService.ts`. Parsers are exported pure functions; views and
editor features live in `*Provider.ts` files. Logic without `vscode` imports lives in
separate modules so `node:test` can test it. There is a mock mode
(`slurmClusterManager.mockMode`) whose fixtures in `src/mockData.ts` are raw command
output fed through the real parsers.

## 2. What to verify, in priority order

For each item: run the command on the cluster, compare with what the parser expects,
and if they differ, fix the parser and add a unit test that uses the **real** output
(anonymise usernames and accounts).

### 2.1 Fair share (just changed, highest priority)

| Command (exactly as the code runs it) | Parser | What the code assumes |
|---|---|---|
| `sshare -a -n -P -o Account,User,FairShare` | `parseSshareOutput` | Pipe-separated; account column indented by tree depth (trimmed); account-level rows have an empty user; user rows' FairShare is the Fair Tree factor in [0, 1] |
| `sacctmgr -n -P show user $USER format=DefaultAccount` | `SlurmService.getDefaultAccount` | First line is the default account name |
| `squeue -u $USER --noheader --format="%i\|%j\|%t\|%M\|%P\|%N\|%l\|%S\|%r\|%a"` | `SlurmService.getJobs` | 10 pipe-separated fields; `%a` (account) is the last one, `parts[9]`. **Not unit-tested**: `getJobs` uses `execAsync` directly, not the injectable runner |
| `sprio -u $USER -h -o "%i\|%Y\|%A\|%F\|%J\|%P\|%Q"` | `parseSprioOutput` | Weighted priority, age, fair share, job size, partition, QOS; padded fields (trimmed); disabled components blank |

Behaviour to confirm:
- With **several accounts**, the Active Jobs header shows the account your jobs run
  under, else the default account, else the highest standing (`getFairShareSummary` in
  `fairShareRanking.ts`). If you have a multi-account user, submit a job with
  `--account=<non-default>` and check the header follows it.
- **Open question #3:** for a job pending in **several partitions**
  (`sbatch -p a,b --hold ...`, then `scontrol release`), does `sprio` print one row per
  partition? If so, `getJobPriorityFactors` keys rows by job ID and the last row wins,
  so the breakdown shows an arbitrary partition. Decide what it should show (probably
  the best partition, or the row matching the job's eventual partition) and fix.

### 2.2 Partition data (GPU Partition Usage, autocomplete, hover, warnings all use it)

| Command | Parser | Assumes |
|---|---|---|
| `sinfo -N --noheader --format="%N\|%P\|%T\|%G"` | `parsePartitionUsageOutput` | One row per node per partition; `%P` default partition ends in `*`; GRES like `gpu:a100:4` or `gpu:4` (untyped, recorded as `generic`) |
| `scontrol show node` | `parseScontrolNodeGpuAllocations` | `AllocTRES=...,gres/gpu=2,gres/gpu:a100=2`: typed entries preferred over the untyped total |
| `sinfo --noheader --format="%P\|%C"` | `parseSinfoCpuOutput` | `%C` is `allocated/idle/other/total` CPUs; a partition can span several lines (summed) |

Check:
- **Idle GPUs per type** (`idleGpusByType`, new) on a partition mixing GPU models. Compare
  against `scontrol show node` by hand for a couple of nodes. Nodes with several GPU
  types and an untyped allocation are approximated (`getNodeIdleGpusByType`).
- The numbers in GPU Partition Usage should match what `sinfo`/`scontrol` report.

### 2.3 Submit-script parsing (autocomplete, hover, warnings)

Shared parser: `src/slurmScriptOptions.ts`; script analysis: `src/slurmScriptAnalysis.ts`.
Verify these Slurm behaviours with `sbatch --test-only` (validates without submitting):

1. **Long-option abbreviations**: `--part=<p>` and `--partit=<p>` are accepted, `--par=` is
   rejected as ambiguous (code: `PARTITION_OPTION`, shortest accepted is `--part`).
2. **`-p<name>` attached form** works.
3. **Header rules**: `#SBATCH` lines after the first command are ignored; the last
   `#SBATCH -p` wins (code: `readScriptHeader`).
4. **GPU option forms**: `--gres=gpu:<type>:<n>`, `--gpus=<type>:<n>`, `-G <type>:<n>`,
   `--gpus-per-node/-task/-socket=<type>:<n>`. Abbreviations like `--gpu=` should be
   ambiguous (the code only accepts full names).
5. **Wrong GPU type**: `sbatch --test-only -p <a100-only partition> --gres=gpu:<type it lacks>:1 --wrap=true`
   should be **rejected** (we expect "Requested node configuration is not available").
   The editor warning claims Slurm rejects this, so confirm the claim and the message.
   Also check a GPU request on a CPU-only partition.
6. **Several partitions**: `-p a,b --gres=gpu:<type only b has>:1` should be **accepted**
   (the warning only fires when *none* of the partitions has the type).
7. **srun inside a job** inherits the job's partition (`resolveLineOrScript`).

### 2.4 Quick live smoke test of the parsers

With mock mode off, this exercises the real commands through the compiled service:

```bash
npm run compile
node -e '
const { SlurmService } = require("./out/slurmService.js");
const { buildPartitionLoads } = require("./out/partitionCompletion.js");
const { buildFairShareLookup, getFairShareSummary, rankJobAccounts } = require("./out/fairShareRanking.js");
(async () => {
  const s = new SlurmService(undefined, undefined, undefined, () => false);
  const usage = await s.getPartitionUsage();
  const cpu = await s.getCpuPartitionUsage();
  console.log("GPU partitions:", usage.entries.map(e => `${e.partition} ${e.allocatedGpus}/${e.availableGpus} idleByType=${JSON.stringify(e.idleGpusByType)}`));
  console.log("Loads (autocomplete order):", buildPartitionLoads(usage.entries, cpu).map(l => `${l.partition}:${l.resource}:${Math.round(l.loadRatio*100)}%`));
  const jobs = await s.getJobs();
  console.log("My jobs + accounts:", jobs.map(j => `${j.jobId} ${j.state} ${j.account}`));
  const fs = await s.getFairShare();
  console.log("Fair share available:", fs.available, "rows:", fs.entries.length);
  const summary = getFairShareSummary(buildFairShareLookup(fs.entries), process.env.USER,
    { jobAccounts: rankJobAccounts(jobs), defaultAccount: await s.getDefaultAccount() });
  console.log("My fair share:", summary);
  console.log("Priority factors:", [...(await s.getJobPriorityFactors()).values()]);
})();'
```

Anything empty, `undefined`, or obviously wrong points at a parser to fix.

## 3. Where things live

| Area | Files |
|---|---|
| Slurm commands + parsers | `src/slurmService.ts` |
| Shared partition snapshot (5-min background refresh) | `src/partitionDataStore.ts`, wiring in `src/extension.ts` |
| Partition autocomplete, partition hover text | `src/partitionCompletion.ts` |
| GPU type autocomplete | `src/gpuTypeCompletion.ts` |
| Script option parsing / script analysis | `src/slurmScriptOptions.ts`, `src/slurmScriptAnalysis.ts` |
| Completion provider (both kinds) | `src/slurmScriptCompletionProvider.ts` |
| Wrong GPU type warnings | `src/slurmScriptDiagnostics.ts` |
| Partition hover + underline | `src/slurmHoverProvider.ts` |
| Fair share | `src/fairShareRanking.ts`, `src/slurmJobProvider.ts` (header row), `src/leaderboardProvider.ts` |
| Mock fixtures | `src/mockData.ts` |
| Tests | `src/test/*.test.ts` (`node:test`, no VS Code harness) |

## 4. Conventions the user expects

- **Commits**: conventional style (`feat:`, `fix:`, `refactor:`), body explains why.
  **No `Co-Authored-By` or other AI attribution.** Never commit the `package.json`
  version bump. Ask before pushing.
- **CHANGELOG**: add entries under `## [Unreleased]` (`### Added/Changed/Fixed`), never
  under a released version. Update README feature text when behaviour changes.
- **Releases** are published by hand; don't add release automation.
- **UI**: minimal. Fold features into existing views, show the fewest values that answer
  the question, propose new rows/buttons before adding them, delete code behind removed UI.
- **No new runtime dependencies.** Tests stay plain `node:test`.
- Keep pure logic out of `vscode`-importing files so it stays testable.

## 5. Done when

- Every command in section 2 has been run, and real output matches the parsers (or the
  parser is fixed and a test with real-shaped output is added).
- The `sbatch --test-only` checks in 2.3 confirm (or correct) the behaviour the code
  relies on.
- Open question #3 is answered and handled.
- `npm test` passes; findings are summarised for the user with what was changed.
