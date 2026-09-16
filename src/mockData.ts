import type {
    ClusterLeaderboardEntry,
    HistoryJob,
    MaintenanceWindow,
    SlurmJob,
} from './slurmService';

/**
 * Fixtures backing `slurmClusterManager.mockMode`, which lets the extension be
 * developed without a Slurm installation.
 *
 * Anything Slurm reports as text is kept here in its raw command output form and
 * parsed by the service's real parsers, so mock mode exercises the same parsing
 * path as a live cluster instead of hand-built result objects.
 *
 * Imports from `slurmService` are type-only on purpose: the service imports this
 * module, and a value import would close the cycle.
 */


export function createMockJobs(): SlurmJob[] {
    return [
        {
            jobId: '91001',
            name: 'train-transformer',
            state: 'R',
            time: '00:42:10',
            partition: 'h200',
            nodes: 'gpu-node[01]',
            stdoutPath: '/work/vision_lab/runs/train-transformer/logs/91001.out',
            stderrPath: '/work/vision_lab/runs/train-transformer/logs/91001.err',
            timeLimit: '02:00:00',
            startTime: '2026-04-28T09:00:00.000Z',
            workDir: '/work/vision_lab/runs/train-transformer',
            submitScript: '/work/vision_lab/slurm/train-transformer.sbatch',
            gpuCount: 2,
            gpuType: 'H200',
            memory: '128G',
        },
        {
            jobId: '91002',
            name: 'large-sweep',
            state: 'PD',
            time: '0:00',
            partition: 'a100-long',
            nodes: 'N/A',
            stdoutPath: 'N/A',
            stderrPath: 'N/A',
            timeLimit: '04:00:00',
            startTime: '2099-01-02T03:04:00.000Z',
            workDir: '/work/atlas_lab/sweeps/large-sweep',
            submitScript: '/work/atlas_lab/slurm/large-sweep.sbatch',
            gpuCount: 4,
            gpuType: 'A100',
            memory: '256G',
            pendingReason: 'Resources',
        },
        {
            jobId: '91003',
            name: 'dependent-eval',
            state: 'PD',
            time: '0:00',
            partition: 'h200',
            nodes: 'N/A',
            stdoutPath: 'N/A',
            stderrPath: 'N/A',
            timeLimit: '01:00:00',
            startTime: 'Unknown',
            workDir: '/work/vision_lab/evals/dependent-eval',
            submitScript: '/work/vision_lab/slurm/dependent-eval.sbatch',
            gpuCount: 1,
            gpuType: 'H200',
            memory: '64G',
            dependency: 'afterok:91001',
            pendingReason: 'Dependency',
        },
        {
            jobId: '91004_[3-10%2]',
            name: 'array-postprocess',
            state: 'PD',
            time: '0:00',
            partition: 'debug-gpu',
            nodes: 'N/A',
            stdoutPath: 'N/A',
            stderrPath: 'N/A',
            timeLimit: '00:30:00',
            startTime: '2099-01-02T04:00:00.000Z',
            workDir: '/work/render_lab/postprocess/array',
            submitScript: '/work/render_lab/slurm/array-postprocess.sbatch',
            gpuCount: 1,
            gpuType: 'A100',
            memory: '32G',
            pendingReason: 'Priority',
        },
        {
            jobId: '91004_3',
            name: 'array-postprocess',
            state: 'PD',
            time: '0:00',
            partition: 'debug-gpu',
            nodes: 'N/A',
            stdoutPath: 'N/A',
            stderrPath: 'N/A',
            timeLimit: '00:30:00',
            startTime: '2099-01-02T04:00:00.000Z',
            workDir: '/work/render_lab/postprocess/array',
            submitScript: '/work/render_lab/slurm/array-postprocess.sbatch',
            gpuCount: 1,
            gpuType: 'A100',
            memory: '32G',
            pendingReason: 'Priority',
        },
        {
            jobId: '91005',
            name: 'cleanup',
            state: 'CG',
            time: '00:04:12',
            partition: 'cpu',
            nodes: 'cpu-node[02]',
            stdoutPath: '/work/data_lab/logs/cleanup-91005.out',
            stderrPath: '/work/data_lab/logs/cleanup-91005.err',
            timeLimit: '00:10:00',
            startTime: '2026-04-28T09:30:00.000Z',
            workDir: '/work/data_lab/maintenance/cleanup',
            submitScript: '/work/data_lab/slurm/cleanup.sbatch',
            memory: '8G',
        },
    ];
}

export function createMockHistoryJobs(): HistoryJob[] {
    return [
        {
            jobId: '90990',
            name: 'finished-training',
            state: 'COMPLETED',
            exitCode: 0,
            startTime: '2026-04-27T10:00:00.000Z',
            endTime: '2026-04-27T11:32:00.000Z',
            elapsed: '01:32:00',
            partition: 'gpu',
            nodes: 'gpu-node[03]',
            cpus: '16',
            maxMemory: '72G',
            stdoutPath: '/work/vision_lab/runs/finished-training/logs/90990.out',
            stderrPath: '/work/vision_lab/runs/finished-training/logs/90990.err',
        },
        {
            jobId: '90991',
            name: 'failed-preprocess',
            state: 'FAILED',
            exitCode: 1,
            startTime: '2026-04-27T12:00:00.000Z',
            endTime: '2026-04-27T12:03:00.000Z',
            elapsed: '00:03:00',
            partition: 'cpu',
            nodes: 'cpu-node[01]',
            cpus: '4',
            maxMemory: '2G',
            stdoutPath: '/work/data_lab/logs/failed-preprocess-90991.out',
            stderrPath: '/work/data_lab/logs/failed-preprocess-90991.err',
        },
        {
            jobId: '90992',
            name: 'ablation-grid',
            state: 'TIMEOUT',
            exitCode: 0,
            startTime: '2026-04-26T18:00:00.000Z',
            endTime: '2026-04-27T06:00:00.000Z',
            elapsed: '12:00:00',
            partition: 'a100-long',
            nodes: 'gpu-node[08-09]',
            cpus: '32',
            maxMemory: '188G',
            stdoutPath: '/work/atlas_lab/runs/ablation-grid/logs/90992.out',
            stderrPath: '/work/atlas_lab/runs/ablation-grid/logs/90992.err',
        },
        {
            jobId: '90993',
            name: 'interactive-probe',
            state: 'CANCELLED',
            exitCode: 0,
            startTime: '2026-04-26T14:15:00.000Z',
            endTime: '2026-04-26T14:46:00.000Z',
            elapsed: '00:31:00',
            partition: 'debug-gpu',
            nodes: 'gpu-node[02]',
            cpus: '8',
            maxMemory: '24G',
            stdoutPath: '/work/proto_lab/logs/interactive-probe-90993.out',
            stderrPath: '/work/proto_lab/logs/interactive-probe-90993.err',
        },
    ];
}

export function createMockLeaderboardEntries(): ClusterLeaderboardEntry[] {
    return [
        {
            username: 'nova42',
            accounts: ['atlas_lab'],
            gpuCount: 24,
            gpuJobCount: 3,
            gpuTypes: [
                { type: 'a100', count: 16 },
                { type: 'h200', count: 8 },
            ],
        },
        {
            username: 'pixelwave',
            accounts: ['vision_lab'],
            gpuCount: 18,
            gpuJobCount: 3,
            gpuTypes: [
                { type: 'h200', count: 10 },
                { type: 'a100', count: 8 },
            ],
        },
        {
            username: 'quartz',
            accounts: ['nebula_lab'],
            gpuCount: 16,
            gpuJobCount: 2,
            gpuTypes: [{ type: 'a100', count: 16 }],
        },
        {
            username: 'zephyr',
            accounts: ['robotics_lab'],
            gpuCount: 8,
            gpuJobCount: 2,
            gpuTypes: [{ type: 'l40s', count: 8 }],
        },
        {
            username: 'solis',
            accounts: ['climate_lab'],
            gpuCount: 8,
            gpuJobCount: 1,
            gpuTypes: [{ type: 'h200', count: 8 }],
        },
        {
            username: 'rune',
            accounts: ['data_lab'],
            gpuCount: 6,
            gpuJobCount: 6,
            gpuTypes: [{ type: 'rtx6000', count: 6 }],
        },
    ];
}

// sacct-style rows for the cluster account overview.
export const MOCK_ACCOUNT_OVERVIEW_ROWS = [
    'nova42|atlas_lab|gpu:a100:8',
    'nova42|atlas_lab|gpu:a100:8',
    'nova42|atlas_lab|gpu:h200:8',
    'pixelwave|vision_lab|gpu:h200:8',
    'pixelwave|vision_lab|gpu:a100:8',
    'pixelwave|vision_lab|gpu:h200:2',
    'quartz|nebula_lab|gpu:a100:8',
    'quartz|nebula_lab|gpu:a100:8',
    'zephyr|robotics_lab|gpu:l40s:4',
    'zephyr|robotics_lab|gpu:l40s:4',
    'solis|climate_lab|gpu:h200:8',
    'rune|data_lab|gpu:rtx6000:1',
    'rune|data_lab|gpu:rtx6000:1',
    'rune|data_lab|gpu:rtx6000:1',
    'rune|data_lab|gpu:rtx6000:1',
    'rune|data_lab|gpu:rtx6000:1',
    'rune|data_lab|gpu:rtx6000:1',
];

// sinfo -N --noheader --format="%N|%P|%T|%G"
export const MOCK_SINFO_NODE_OUTPUT = [
    // h200 partition (default): 6 nodes, 2 allocated, 3 idle, 1 other
    'gpu-h200-01|h200*|allocated|gpu:h200:4',
    'gpu-h200-02|h200*|allocated|gpu:h200:4',
    'gpu-h200-03|h200*|idle|gpu:h200:4',
    'gpu-h200-04|h200*|idle|gpu:h200:4',
    'gpu-h200-05|h200*|idle|gpu:h200:4',
    'gpu-h200-06|h200*|drain|gpu:h200:4',
    // a100-long: 8 nodes, 4 allocated, 3 idle, 1 other
    'gpu-a100-01|a100-long|allocated|gpu:a100:4',
    'gpu-a100-02|a100-long|allocated|gpu:a100:4',
    'gpu-a100-03|a100-long|allocated|gpu:a100:4',
    'gpu-a100-04|a100-long|allocated|gpu:a100:4',
    'gpu-a100-05|a100-long|idle|gpu:a100:4',
    'gpu-a100-06|a100-long|idle|gpu:a100:4',
    'gpu-a100-07|a100-long|idle|gpu:a100:4',
    'gpu-a100-08|a100-long|drain|gpu:a100:4',
    // a100-short: 6 nodes (shares some with a100-long), 1 allocated, 5 idle
    'gpu-a100-01|a100-short|allocated|gpu:a100:4',
    'gpu-a100-02|a100-short|idle|gpu:a100:4',
    'gpu-a100-03|a100-short|idle|gpu:a100:4',
    'gpu-a100-04|a100-short|idle|gpu:a100:4',
    'gpu-a100-05|a100-short|idle|gpu:a100:4',
    'gpu-a100-06|a100-short|idle|gpu:a100:4',
    // l40s: 5 nodes, 1 allocated, 4 idle
    'gpu-l40s-01|l40s|allocated|gpu:l40s:4',
    'gpu-l40s-02|l40s|idle|gpu:l40s:4',
    'gpu-l40s-03|l40s|idle|gpu:l40s:4',
    'gpu-l40s-04|l40s|idle|gpu:l40s:4',
    'gpu-l40s-05|l40s|idle|gpu:l40s:4',
    // debug-gpu: 2 nodes, both idle
    'gpu-debug-01|debug-gpu|idle|gpu:a100:1',
    'gpu-debug-02|debug-gpu|idle|gpu:a100:1',
    // cpu-only
    'cpu-01|cpu|allocated|(null)',
].join('\n');

// scontrol show node (AllocTRES ground truth)
export const MOCK_SCONTROL_NODE_OUTPUT = [
    'NodeName=gpu-h200-01 Arch=x86_64 CoresPerSocket=64',
    ' OS=Linux 5.15.0 #1 SMP',
    ' CfgTRES=cpu=192,mem=2048G,gres/gpu=4,gres/gpu:h200=4',
    ' AllocTRES=cpu=128,mem=1280G,gres/gpu=2,gres/gpu:h200=2',
    'NodeName=gpu-h200-02 Arch=x86_64 CoresPerSocket=64',
    ' CfgTRES=cpu=192,mem=2048G,gres/gpu=4,gres/gpu:h200=4',
    ' AllocTRES=cpu=192,mem=2048G,gres/gpu=4,gres/gpu:h200=4',
    'NodeName=gpu-h200-03 Arch=x86_64',
    ' CfgTRES=cpu=192,mem=2048G,gres/gpu=4,gres/gpu:h200=4',
    ' AllocTRES=',
    'NodeName=gpu-h200-04 Arch=x86_64',
    ' CfgTRES=cpu=192,mem=2048G,gres/gpu=4,gres/gpu:h200=4',
    ' AllocTRES=',
    'NodeName=gpu-h200-05 Arch=x86_64',
    ' CfgTRES=cpu=192,mem=2048G,gres/gpu=4,gres/gpu:h200=4',
    ' AllocTRES=',
    'NodeName=gpu-h200-06 Arch=x86_64',
    ' CfgTRES=cpu=192,mem=2048G,gres/gpu=4,gres/gpu:h200=4',
    ' AllocTRES=',
    'NodeName=gpu-a100-01 Arch=x86_64',
    ' CfgTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    ' AllocTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    'NodeName=gpu-a100-02 Arch=x86_64',
    ' CfgTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    ' AllocTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    'NodeName=gpu-a100-03 Arch=x86_64',
    ' CfgTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    ' AllocTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    'NodeName=gpu-a100-04 Arch=x86_64',
    ' CfgTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    ' AllocTRES=cpu=64,mem=512G,gres/gpu=2,gres/gpu:a100=2',
    'NodeName=gpu-a100-05 Arch=x86_64',
    ' CfgTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    ' AllocTRES=',
    'NodeName=gpu-a100-06 Arch=x86_64',
    ' CfgTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    ' AllocTRES=',
    'NodeName=gpu-a100-07 Arch=x86_64',
    ' CfgTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    ' AllocTRES=',
    'NodeName=gpu-a100-08 Arch=x86_64',
    ' CfgTRES=cpu=128,mem=1024G,gres/gpu=4,gres/gpu:a100=4',
    ' AllocTRES=',
    'NodeName=gpu-l40s-01 Arch=x86_64',
    ' CfgTRES=cpu=64,mem=512G,gres/gpu=4,gres/gpu:l40s=4',
    ' AllocTRES=cpu=64,mem=512G,gres/gpu=4,gres/gpu:l40s=4',
    'NodeName=gpu-l40s-02 Arch=x86_64',
    ' CfgTRES=cpu=64,mem=512G,gres/gpu=4,gres/gpu:l40s=4',
    ' AllocTRES=',
    'NodeName=gpu-l40s-03 Arch=x86_64',
    ' CfgTRES=cpu=64,mem=512G,gres/gpu=4,gres/gpu:l40s=4',
    ' AllocTRES=',
    'NodeName=gpu-l40s-04 Arch=x86_64',
    ' CfgTRES=cpu=64,mem=512G,gres/gpu=4,gres/gpu:l40s=4',
    ' AllocTRES=',
    'NodeName=gpu-l40s-05 Arch=x86_64',
    ' CfgTRES=cpu=64,mem=512G,gres/gpu=4,gres/gpu:l40s=4',
    ' AllocTRES=',
    'NodeName=gpu-debug-01 Arch=x86_64',
    ' CfgTRES=cpu=32,mem=256G,gres/gpu=1,gres/gpu:a100=1',
    ' AllocTRES=',
    'NodeName=gpu-debug-02 Arch=x86_64',
    ' CfgTRES=cpu=32,mem=256G,gres/gpu=1,gres/gpu:a100=1',
    ' AllocTRES=',
    'NodeName=cpu-01 Arch=x86_64',
    ' CfgTRES=cpu=64,mem=512G',
    ' AllocTRES=cpu=8,mem=32G',
].join('\n');

// squeue --noheader --format="%P|%t" (job counts only)
export const MOCK_SQUEUE_PARTITION_JOBS_OUTPUT = [
    'h200|R',
    'h200|R',
    'h200|PD',
    'a100-long|R',
    'a100-long|R',
    'a100-long|PD',
    'a100-short,h200|PD',
    'a100-short|R',
    'a100-short|PD',
    'l40s|R',
    'l40s|PD',
    'debug-gpu|PD',
    'cpu|R',
    'cpu|PD',
].join('\n');

// sshare -a -n -P -o Account,User,FairShare
// The account column is indented by tree depth, exactly as Slurm prints it.
// nova42 hoards GPUs and ranks last; rune barely uses the cluster and tops the
// Fair Tree ranking.
export const MOCK_SSHARE_OUTPUT = [
    'root||1.000000',
    '  atlas_lab||0.142857',
    '   atlas_lab|nova42|0.142857',
    '  vision_lab||0.428571',
    '   vision_lab|pixelwave|0.428571',
    '   vision_lab|kawi19|0.714286',
    '  nebula_lab||0.571429',
    '   nebula_lab|quartz|0.571429',
    '  robotics_lab||0.857143',
    '   robotics_lab|zephyr|0.857143',
    '  climate_lab||0.785714',
    '   climate_lab|solis|0.785714',
    '  data_lab||1.000000',
    '   data_lab|rune|1.000000',
].join('\n');

// sprio -u $USER -h -o "%i|%Y|%A|%F|%J|%P|%Q"
// Only queued jobs appear in sprio output, matching the pending mock jobs.
export const MOCK_SPRIO_OUTPUT = [
    '91002|10432|1580|2104|120|748|6000',
    '91003|9315|640|2104|120|748|6000',
    '91004_3|8890|215|2104|120|748|6000',
].join('\n');

export function createMockMaintenanceWindows(): MaintenanceWindow[] {
    const start = new Date();
    start.setDate(start.getDate() + 2);
    const end = new Date(start.getTime());
    end.setHours(end.getHours() + 6);

    return [
        {
            name: 'monthly_maintenance',
            nodes: 'ALL',
            startTime: start.toISOString(),
            endTime: end.toISOString(),
        },
    ];
}
