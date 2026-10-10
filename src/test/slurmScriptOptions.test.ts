import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    findLineSegments,
    findOptionOccurrencesInSegment,
    PARTITION_OPTION,
    readSegmentPartitions,
    resolveLineOrScript,
} from '../slurmScriptOptions';

describe('findLineSegments', () => {
    it('finds the directive on an #SBATCH line', () => {
        assert.deepEqual(findLineSegments('#SBATCH -p a'), [{ start: 7, kind: 'directive' }]);
    });

    it('finds every Slurm command on a line', () => {
        assert.deepEqual(findLineSegments('srun -p a x && sbatch job.sh').map(segment => segment.kind), ['srun', 'sbatch']);
    });

    it('finds nothing in plain comments or other commands', () => {
        assert.deepEqual(findLineSegments('# srun -p a'), []);
        assert.deepEqual(findLineSegments('##SBATCH -p a'), []);
        assert.deepEqual(findLineSegments('python train.py'), []);
    });
});

describe('findOptionOccurrencesInSegment', () => {
    it('reads a command\'s own options but not its program\'s', () => {
        const line = 'srun -N 2 -p gpu python train.py -p 5';
        assert.deepEqual(
            findOptionOccurrencesInSegment(line, findLineSegments(line)[0], PARTITION_OPTION),
            [{ option: '-p', value: 'gpu', valueStart: 13 }],
        );
    });

    it('reads every form of the option, with value positions past any quote', () => {
        const line = '#SBATCH -pa --partition="b" --part c';
        assert.deepEqual(findOptionOccurrencesInSegment(line, findLineSegments(line)[0], PARTITION_OPTION), [
            { option: '-p', value: 'a', valueStart: 10 },
            { option: '--partition', value: 'b', valueStart: 25 },
            { option: '--part', value: 'c', valueStart: 35 },
        ]);
    });

    it('keeps each command on a line to its own options', () => {
        const line = 'srun -p a x && srun -p b y';
        const [first, second] = findLineSegments(line);
        assert.deepEqual(readSegmentPartitions(line, first), ['a']);
        assert.deepEqual(readSegmentPartitions(line, second), ['b']);
    });
});

describe('readSegmentPartitions', () => {
    it('lets a later partition option on the line override an earlier one', () => {
        const line = '#SBATCH -p a -p b,c';
        assert.deepEqual(readSegmentPartitions(line, findLineSegments(line)[0]), ['b', 'c']);
    });
});

describe('resolveLineOrScript', () => {
    it('uses the header for directives', () => {
        assert.deepEqual(resolveLineOrScript('directive', ['own'], ['header']), ['header']);
    });

    it('prefers a command\'s own value', () => {
        assert.deepEqual(resolveLineOrScript('srun', ['own'], ['header']), ['own']);
        assert.deepEqual(resolveLineOrScript('sbatch', ['own'], ['header']), ['own']);
    });

    it('falls back to the header for job steps', () => {
        assert.deepEqual(resolveLineOrScript('srun', [], ['header']), ['header']);
        assert.deepEqual(resolveLineOrScript('salloc', [], ['header']), ['header']);
    });

    it('knows nothing for an sbatch line, which submits another script', () => {
        assert.deepEqual(resolveLineOrScript('sbatch', [], ['header']), []);
    });
});
