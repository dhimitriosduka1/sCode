import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CpuPartitionUsage, parseSinfoCpuOutput, PartitionUsageEntry, SlurmService } from '../slurmService';
import {
    buildPartitionLoads,
    findPartitionCompletionContext,
    formatPartitionLoadDescription,
    formatPartitionLoadDocumentation,
} from '../partitionCompletion';

/** Context with the cursor at `|` in the line */
function contextAt(lineWithCursor: string) {
    const cursor = lineWithCursor.indexOf('|');
    assert.ok(cursor >= 0, 'test line needs a | cursor marker');
    const line = lineWithCursor.slice(0, cursor) + lineWithCursor.slice(cursor + 1);
    return findPartitionCompletionContext(line, cursor);
}

/** The text completion would replace, for readable assertions */
function replaced(lineWithCursor: string): string | undefined {
    const context = contextAt(lineWithCursor);
    if (!context) {
        return undefined;
    }
    const line = lineWithCursor.replace('|', '');
    return line.slice(context.replaceStart, context.replaceEnd);
}

describe('findPartitionCompletionContext', () => {
    describe('#SBATCH directives', () => {
        it('completes after --partition=', () => {
            assert.deepEqual(contextAt('#SBATCH --partition=|'), { prefix: '', replaceStart: 20, replaceEnd: 20, alreadyListed: [] });
        });

        it('completes a partially typed name', () => {
            assert.equal(contextAt('#SBATCH --partition=gp|')?.prefix, 'gp');
        });

        it('completes after --partition and a space', () => {
            assert.equal(contextAt('#SBATCH --partition |')?.prefix, '');
            assert.equal(contextAt('#SBATCH --partition a1|')?.prefix, 'a1');
        });

        it('completes after -p, with or without a space', () => {
            assert.equal(contextAt('#SBATCH -p |')?.prefix, '');
            assert.equal(contextAt('#SBATCH -p h2|')?.prefix, 'h2');
            assert.equal(contextAt('#SBATCH -ph2|')?.prefix, 'h2');
        });

        it('accepts unambiguous abbreviations of --partition', () => {
            assert.equal(contextAt('#SBATCH --part=|')?.prefix, '');
            assert.equal(contextAt('#SBATCH --partit l4|')?.prefix, 'l4');
        });

        it('rejects ambiguous or unrelated options', () => {
            assert.equal(contextAt('#SBATCH --par=|'), undefined);
            assert.equal(contextAt('#SBATCH --parsable |'), undefined);
            assert.equal(contextAt('#SBATCH --profile=|'), undefined);
            assert.equal(contextAt('#SBATCH --time=|'), undefined);
            assert.equal(contextAt('#SBATCH -N |'), undefined);
        });

        it('finds the option among others on the same line', () => {
            assert.equal(contextAt('#SBATCH -N 2 --partition=|')?.prefix, '');
        });

        it('stops at the end of the value', () => {
            assert.equal(contextAt('#SBATCH --partition=gpu |'), undefined);
        });

        it('completes inside a quoted value', () => {
            assert.equal(replaced('#SBATCH --partition="a1|'), 'a1');
            assert.equal(contextAt('#SBATCH --partition="a,b" |'), undefined);
        });

        it('ignores disabled directives and plain comments', () => {
            assert.equal(contextAt('##SBATCH --partition=|'), undefined);
            assert.equal(contextAt('# run with --partition=|'), undefined);
            assert.equal(contextAt('# export SBATCH_PARTITION=|'), undefined);
        });
    });

    describe('multiple partitions', () => {
        it('completes the slot after the last comma, listing earlier ones', () => {
            assert.deepEqual(contextAt('#SBATCH --partition=gpu1,|'), {
                prefix: '', replaceStart: 25, replaceEnd: 25, alreadyListed: ['gpu1'],
            });
            assert.deepEqual(contextAt('#SBATCH -p gpu1,gpu2,c|')?.alreadyListed, ['gpu1', 'gpu2']);
            assert.equal(contextAt('#SBATCH -p gpu1,gpu2,c|')?.prefix, 'c');
        });

        it('replaces the whole slot under the cursor and lists the ones after it', () => {
            const line = '#SBATCH --partition=gpu1,gp|u2,cpu';
            assert.equal(replaced(line), 'gpu2');
            assert.deepEqual(contextAt(line)?.alreadyListed, ['gpu1', 'cpu']);
        });

        it('skips empty slots from doubled commas', () => {
            assert.deepEqual(contextAt('#SBATCH -p a,,|')?.alreadyListed, ['a']);
        });
    });

    describe('srun, salloc and sbatch command lines', () => {
        it('completes the command\'s own partition option', () => {
            assert.equal(contextAt('srun --partition=|')?.prefix, '');
            assert.equal(contextAt('salloc -p |')?.prefix, '');
            assert.equal(contextAt('sbatch -N 2 -p gp|')?.prefix, 'gp');
            assert.equal(contextAt('  JOB=$(sbatch --parsable --partition=|')?.prefix, '');
            assert.equal(contextAt('cd run && srun -p |')?.prefix, '');
        });

        it('ignores -p belonging to the launched program', () => {
            assert.equal(contextAt('srun python train.py -p |'), undefined);
            assert.equal(contextAt('srun -N 2 mkdir -p |'), undefined);
        });

        it('ignores -p on lines without a Slurm command', () => {
            assert.equal(contextAt('mkdir -p |'), undefined);
            assert.equal(contextAt('python run.py --partition=|'), undefined);
            assert.equal(contextAt('mysrun -p |'), undefined);
        });
    });

    describe('environment variables', () => {
        it('completes SBATCH_PARTITION, SALLOC_PARTITION and SLURM_PARTITION', () => {
            assert.equal(contextAt('export SBATCH_PARTITION=|')?.prefix, '');
            assert.equal(contextAt('SALLOC_PARTITION=a|')?.prefix, 'a');
            assert.equal(contextAt('export SLURM_PARTITION="a,b|')?.prefix, 'b');
            assert.deepEqual(contextAt('export SLURM_PARTITION="a,b|')?.alreadyListed, ['a']);
        });

        it('ignores look-alike variables', () => {
            assert.equal(contextAt('export MY_PARTITION=|'), undefined);
            assert.equal(contextAt('export SBATCH_PARTITIONS=|'), undefined);
        });
    });
});

describe('parseSinfoCpuOutput', () => {
    it('parses CPU counts per partition, dropping the default marker from names', () => {
        assert.deepEqual(parseSinfoCpuOutput('h200*|300/660/192/1152\ncpu|110/18/0/128\n'), [
            { partition: 'h200', allocatedCpus: 300, idleCpus: 660, otherCpus: 192, totalCpus: 1152 },
            { partition: 'cpu', allocatedCpus: 110, idleCpus: 18, otherCpus: 0, totalCpus: 128 },
        ]);
    });

    it('sums partitions that sinfo splits across lines', () => {
        const [usage] = parseSinfoCpuOutput('cpu|10/20/0/30\ncpu|5/0/5/10');
        assert.deepEqual(
            [usage.allocatedCpus, usage.idleCpus, usage.otherCpus, usage.totalCpus],
            [15, 20, 5, 40],
        );
    });

    it('skips malformed lines', () => {
        assert.deepEqual(parseSinfoCpuOutput('garbage\ncpu|1/2/3\n|1/2/3/4\n'), []);
    });
});

function gpuEntry(overrides: Partial<PartitionUsageEntry>): PartitionUsageEntry {
    return {
        partition: 'gpu', isDefault: false,
        totalNodes: 4, allocatedNodes: 2, idleNodes: 2, otherNodes: 0,
        totalGpus: 16, availableGpus: 16, allocatedGpus: 8, idleGpus: 8,
        runningJobs: 2, pendingJobs: 0, gpuTypes: [],
        ...overrides,
    };
}

function cpuEntry(overrides: Partial<CpuPartitionUsage>): CpuPartitionUsage {
    return { partition: 'cpu', allocatedCpus: 50, idleCpus: 50, otherCpus: 0, totalCpus: 100, ...overrides };
}

describe('buildPartitionLoads', () => {
    it('lists GPU partitions before CPU-only ones, each ranked on its own resource, least busy first', () => {
        const loads = buildPartitionLoads(
            [gpuEntry({ partition: 'busy-gpu', allocatedGpus: 15, idleGpus: 1 }), gpuEntry({ partition: 'quiet-gpu', allocatedGpus: 2, idleGpus: 14 })],
            [
                cpuEntry({ partition: 'busy-gpu', allocatedCpus: 1, idleCpus: 99 }),
                cpuEntry({ partition: 'quiet-gpu' }),
                cpuEntry({ partition: 'cpu', allocatedCpus: 40, idleCpus: 60 }),
            ],
        );

        assert.deepEqual(loads.map(load => [load.partition, load.resource, Math.round(load.loadRatio * 100)]), [
            ['quiet-gpu', 'GPU', 13],
            ['busy-gpu', 'GPU', 94],
            ['cpu', 'CPU', 40],
        ]);
    });

    it('excludes unavailable CPUs from capacity and ranks fully unavailable partitions last', () => {
        const loads = buildPartitionLoads([], [
            cpuEntry({ partition: 'drained', allocatedCpus: 0, idleCpus: 0, otherCpus: 100 }),
            cpuEntry({ partition: 'half-down', allocatedCpus: 25, idleCpus: 25, otherCpus: 50 }),
        ]);

        assert.deepEqual(loads.map(load => [load.partition, load.loadRatio]), [['half-down', 0.5], ['drained', 1]]);
    });

    it('breaks ties on pending jobs, then idle capacity, then name', () => {
        const loads = buildPartitionLoads([
            gpuEntry({ partition: 'b', pendingJobs: 3 }),
            gpuEntry({ partition: 'a', pendingJobs: 3 }),
            gpuEntry({ partition: 'c', pendingJobs: 0 }),
        ], []);

        assert.deepEqual(loads.map(load => load.partition), ['c', 'a', 'b']);
    });
});

describe('partition load formatting', () => {
    it('describes load and idle capacity in the resource that ranks it', () => {
        const [gpu] = buildPartitionLoads([gpuEntry({ allocatedGpus: 6, idleGpus: 10, isDefault: true })], []);
        const [cpu] = buildPartitionLoads([], [cpuEntry({ allocatedCpus: 99, idleCpus: 1 })]);

        assert.equal(formatPartitionLoadDescription(gpu), '38% busy · 10 idle GPUs');
        assert.equal(formatPartitionLoadDescription(cpu), '99% busy · 1 idle CPU');
    });

    it('documents CPU-only partitions with their CPU breakdown', () => {
        const [cpu] = buildPartitionLoads([], [cpuEntry({ allocatedCpus: 40, idleCpus: 50, otherCpus: 10 })]);
        const markdown = formatPartitionLoadDocumentation(cpu);

        assert.match(markdown, /^\*\*cpu\*\*/);
        assert.match(markdown, /40\/90 CPUs · 50 idle/);
        assert.match(markdown, /- \*\*CPUs:\*\* 40 allocated, 50 idle, 10 unavailable, 100 total/);
    });

    it('reuses the GPU Partition Usage tooltip for GPU partitions, without the default row', () => {
        const [gpu] = buildPartitionLoads([gpuEntry({ isDefault: true })], []);
        const markdown = formatPartitionLoadDocumentation(gpu);

        assert.match(markdown, /- \*\*Load:\*\* 50%\n- \*\*GPUs:\*\* 8 allocated, 8 idle, 16 available, 16 total/);
        assert.doesNotMatch(markdown, /Default/);
    });

    it('leaves CPU-only partition details without a default row', () => {
        const [cpu] = buildPartitionLoads([], [cpuEntry({})]);
        assert.doesNotMatch(formatPartitionLoadDocumentation(cpu), /Default/);
    });
});

describe('partition loads in mock mode', () => {
    it('offers every mock partition, CPU-only included, least busy first', async () => {
        const service = new SlurmService(undefined, undefined, async (command) => {
            throw new Error(`Unexpected command in mock mode: ${command}`);
        }, () => true);

        const loads = buildPartitionLoads(
            (await service.getPartitionUsage()).entries,
            await service.getCpuPartitionUsage(),
        );

        assert.ok(loads.some(load => load.partition === 'cpu' && load.resource === 'CPU'));
        assert.equal(loads[loads.length - 1].partition, 'cpu');
        for (const resource of ['GPU', 'CPU']) {
            const ratios = loads.filter(load => load.resource === resource).map(load => load.loadRatio);
            assert.deepEqual(ratios, [...ratios].sort((a, b) => a - b));
        }
    });
});
