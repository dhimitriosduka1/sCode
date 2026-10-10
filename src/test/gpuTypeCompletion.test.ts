import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { PartitionUsageEntry, SlurmService } from '../slurmService';
import {
    buildGpuTypeSuggestions,
    findGpuTypeCompletionContext,
    formatGpuTypeDescription,
    formatGpuTypeDocumentation,
    readGpuTypeRequests,
} from '../gpuTypeCompletion';

/** Context with the cursor at `|` in the line */
function contextAt(lineWithCursor: string) {
    const cursor = lineWithCursor.indexOf('|');
    assert.ok(cursor >= 0, 'test line needs a | cursor marker');
    return findGpuTypeCompletionContext(lineWithCursor.slice(0, cursor) + lineWithCursor.slice(cursor + 1), cursor);
}

/** The text completion would replace */
function replaced(lineWithCursor: string): string | undefined {
    const context = contextAt(lineWithCursor);
    return context && lineWithCursor.replace('|', '').slice(context.replaceStart, context.replaceEnd);
}

describe('findGpuTypeCompletionContext', () => {
    describe('--gres', () => {
        it('completes the type after gpu:', () => {
            assert.equal(contextAt('#SBATCH --gres=gpu:|')?.prefix, '');
            assert.equal(contextAt('#SBATCH --gres=gpu:a1|')?.prefix, 'a1');
            assert.equal(contextAt('#SBATCH --gres gpu:|')?.prefix, '');
        });

        it('completes a gpu item later in a gres list', () => {
            assert.equal(contextAt('#SBATCH --gres=shard:1,gpu:|')?.prefix, '');
        });

        it('waits for gpu: rather than guessing', () => {
            assert.equal(contextAt('#SBATCH --gres=|'), undefined);
            assert.equal(contextAt('#SBATCH --gres=gp|'), undefined);
            assert.equal(contextAt('#SBATCH --gres=shard:|'), undefined);
        });

        it('stops completing once the count is being typed', () => {
            assert.equal(contextAt('#SBATCH --gres=gpu:a100:|'), undefined);
        });

        it('replaces just the type, keeping a count after it', () => {
            assert.equal(replaced('#SBATCH --gres=gpu:a1|00:2'), 'a100');
        });
    });

    describe('--gpus and its variants', () => {
        it('completes the type before the count', () => {
            assert.equal(contextAt('#SBATCH --gpus=|')?.prefix, '');
            assert.equal(contextAt('#SBATCH --gpus=h2|')?.prefix, 'h2');
            assert.equal(contextAt('#SBATCH -G |')?.prefix, '');
            assert.equal(contextAt('#SBATCH -Ga1|')?.prefix, 'a1');
            assert.equal(contextAt('#SBATCH --gpus-per-node=|')?.prefix, '');
            assert.equal(contextAt('#SBATCH --gpus-per-task a|')?.prefix, 'a');
            assert.equal(contextAt('#SBATCH --gpus-per-socket=|')?.prefix, '');
        });

        it('stops completing once the count is being typed', () => {
            assert.equal(contextAt('#SBATCH --gpus=a100:|'), undefined);
        });

        it('completes the next item of a list, listing types already requested', () => {
            const context = contextAt('#SBATCH --gpus=a100:2,|,h200:1,4');
            assert.equal(context?.prefix, '');
            assert.deepEqual(context?.alreadyListed, ['a100', 'h200']);
        });

        it('rejects ambiguous abbreviations and unrelated GPU options', () => {
            assert.equal(contextAt('#SBATCH --gpu=|'), undefined);
            assert.equal(contextAt('#SBATCH --gres-flags=|'), undefined);
            assert.equal(contextAt('#SBATCH --gpu-bind=|'), undefined);
        });
    });

    it('lists types already requested in a gres list', () => {
        assert.deepEqual(contextAt('#SBATCH --gres=gpu:a100:2,gpu:|')?.alreadyListed, ['a100']);
        assert.deepEqual(contextAt('#SBATCH --gres=gpu:2,gpu:|')?.alreadyListed, []);
    });

    it('reads the line kind and the partitions named on the same line', () => {
        const context = contextAt('srun -p h200,l40s --gpus=|');
        assert.equal(context?.segment.kind, 'srun');
        assert.deepEqual(context?.linePartitions, ['h200', 'l40s']);

        assert.deepEqual(contextAt('srun --gpus=| -p a100')?.linePartitions, ['a100']);
        assert.equal(contextAt('#SBATCH --gres=gpu:|')?.segment.kind, 'directive');
        assert.deepEqual(contextAt('srun -p a -p b --gpus=|')?.linePartitions, ['b']);
    });

    it('ignores the launched program\'s own options and plain comments', () => {
        assert.equal(contextAt('srun python train.py --gpus=|'), undefined);
        assert.equal(contextAt('# use --gres=gpu:|'), undefined);
    });
});

function entry(partition: string, gpuTypes: [string, number, number][]): PartitionUsageEntry {
    return {
        partition, isDefault: false,
        totalNodes: 1, allocatedNodes: 0, idleNodes: 1, otherNodes: 0,
        totalGpus: 0, availableGpus: 0, allocatedGpus: 0, idleGpus: 0,
        runningJobs: 0, pendingJobs: 0,
        gpuTypes: gpuTypes.map(([type, total]) => ({ type, count: total })),
        idleGpusByType: gpuTypes.map(([type, , idle]) => ({ type, count: idle })),
    };
}

describe('readGpuTypeRequests', () => {
    it('finds each requested type and its columns in a --gres value', () => {
        const value = 'gpu:a100:2,shard:1,gpu:2,gpu:h200';
        assert.deepEqual(readGpuTypeRequests({ option: '--gres', value, valueStart: 10 }), [
            { type: 'a100', start: 14, end: 18 },
            { type: 'h200', start: 39, end: 43 },
        ]);
    });

    it('finds each requested type in a --gpus value, skipping bare counts', () => {
        assert.deepEqual(readGpuTypeRequests({ option: '--gpus', value: 'a100:1,4,v100:2', valueStart: 0 }), [
            { type: 'a100', start: 0, end: 4 },
            { type: 'v100', start: 9, end: 13 },
        ]);
    });
});

describe('buildGpuTypeSuggestions', () => {
    const entries = [
        entry('a100-long', [['a100', 32, 14]]),
        entry('a100-short', [['a100', 24, 10]]),
        entry('mixed', [['v100', 8, 6], ['a100', 4, 0]]),
        entry('h200', [['h200', 24, 3]]),
    ];

    it('limits types to the named partitions, most idle first', () => {
        const suggestions = buildGpuTypeSuggestions(entries, ['mixed'], []);
        assert.equal(suggestions.kind, 'types');
        assert.deepEqual(suggestions.kind === 'types' && suggestions.types.map(t => [t.type, t.best.idle]), [['v100', 6], ['a100', 0]]);
    });

    it('takes the best partition\'s idle count instead of summing overlapping partitions', () => {
        const suggestions = buildGpuTypeSuggestions(entries, ['a100-long', 'a100-short'], []);
        assert.ok(suggestions.kind === 'types');
        const [a100] = suggestions.types;
        assert.deepEqual([a100.type, a100.best.partition, a100.best.idle], ['a100', 'a100-long', 14]);
        assert.deepEqual(a100.partitions.map(p => p.partition), ['a100-long', 'a100-short']);
    });

    it('offers every GPU partition\'s types when no partition is named', () => {
        const suggestions = buildGpuTypeSuggestions(entries, [], []);
        assert.ok(suggestions.kind === 'types');
        assert.deepEqual(suggestions.types.map(t => t.type), ['a100', 'v100', 'h200']);
        assert.equal(suggestions.partitionCount, 4);
    });

    it('leaves out types already requested', () => {
        const suggestions = buildGpuTypeSuggestions(entries, ['mixed'], ['v100']);
        assert.ok(suggestions.kind === 'types');
        assert.deepEqual(suggestions.types.map(t => t.type), ['a100']);
    });

    it('explains when the named partitions have no GPUs', () => {
        assert.deepEqual(buildGpuTypeSuggestions(entries, ['cpu'], []), { kind: 'none', reason: 'cpu has no GPUs' });
        assert.deepEqual(buildGpuTypeSuggestions(entries, ['cpu', 'bigmem'], []), { kind: 'none', reason: 'cpu, bigmem have no GPUs' });
    });

    it('explains when the GPUs have no type to name', () => {
        assert.deepEqual(
            buildGpuTypeSuggestions([entry('plain', [['generic', 8, 8]])], ['plain'], []),
            { kind: 'none', reason: 'GPUs here have no type; request a count only' },
        );
    });

    it('explains when every type is already listed', () => {
        assert.deepEqual(buildGpuTypeSuggestions(entries, ['h200'], ['h200']), { kind: 'none', reason: 'all GPU types already listed' });
    });

    it('falls back to the partition\'s idle count for single-type data without a per-type breakdown', () => {
        const legacy = { ...entry('old', [['a100', 8, 0]]), idleGpusByType: undefined, idleGpus: 5 };
        const suggestions = buildGpuTypeSuggestions([legacy], [], []);
        assert.ok(suggestions.kind === 'types');
        assert.equal(suggestions.types[0].best.idle, 5);
    });
});

describe('GPU type formatting', () => {
    const suggestions = buildGpuTypeSuggestions(
        [entry('a100-long', [['a100', 32, 14]]), entry('a100-short', [['a100', 24, 10]])],
        [],
        [],
    );
    assert.ok(suggestions.kind === 'types');
    const [a100] = suggestions.types;

    it('names the best partition when several are in play', () => {
        assert.equal(formatGpuTypeDescription(a100, 2), '14 idle of 32 · a100-long');
        assert.equal(formatGpuTypeDescription(a100, 1), '14 idle of 32');
    });

    it('lists each partition in the details', () => {
        assert.equal(formatGpuTypeDocumentation(a100), [
            '**GPU type: a100**',
            '',
            '**Idle by partition**',
            '- a100-long: 14 idle of 32',
            '- a100-short: 10 idle of 24',
        ].join('\n'));
    });
});

describe('GPU types in mock mode', () => {
    it('derives per-type idle counts from the mock cluster', async () => {
        const service = new SlurmService(undefined, undefined, async (command) => {
            throw new Error(`Unexpected command in mock mode: ${command}`);
        }, () => true);
        const { entries } = await service.getPartitionUsage();

        const suggestions = buildGpuTypeSuggestions(entries, ['a100-long'], []);
        assert.ok(suggestions.kind === 'types');
        assert.deepEqual(suggestions.types.map(t => [t.type, t.best.idle, t.best.total]), [['a100', 14, 32]]);
    });
});
