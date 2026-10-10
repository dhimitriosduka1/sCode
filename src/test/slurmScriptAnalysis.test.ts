import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { PartitionUsageEntry } from '../slurmService';
import { analyzeScript, findGpuTypeProblems, readScriptHeader } from '../slurmScriptAnalysis';

describe('readScriptHeader', () => {
    it('reads the partition from #SBATCH directives in any form', () => {
        assert.deepEqual(readScriptHeader(['#!/bin/bash', '#SBATCH --partition=a100']).partitions, ['a100']);
        assert.deepEqual(readScriptHeader(['#SBATCH -p h200,l40s']).partitions, ['h200', 'l40s']);
        assert.deepEqual(readScriptHeader(['#SBATCH --part "gpu"']).partitions, ['gpu']);
        assert.deepEqual(readScriptHeader(['#SBATCH -N 2 -pcpu']).partitions, ['cpu']);
    });

    it('lets the last partition directive win, as sbatch does', () => {
        assert.deepEqual(readScriptHeader(['#SBATCH -p a', '#SBATCH --time=1:00', '#SBATCH -p b']).partitions, ['b']);
    });

    it('collects every GPU type the header requests', () => {
        assert.deepEqual(readScriptHeader(['#SBATCH --gres=gpu:a100:2', '#SBATCH --gpus-per-node=v100:1']).gpuTypes, ['a100', 'v100']);
    });

    it('ignores directives after the first command, as sbatch does', () => {
        const header = readScriptHeader(['#SBATCH -p a', '', '# comment', 'module load cuda', '#SBATCH -p b --gpus=h200:1']);
        assert.deepEqual(header, { partitions: ['a'], gpuTypes: [] });
    });

    it('ignores disabled ##SBATCH directives', () => {
        assert.deepEqual(readScriptHeader(['##SBATCH -p a --gres=gpu:a100']), { partitions: [], gpuTypes: [] });
    });
});

describe('analyzeScript', () => {
    it('reads header directives and Slurm commands anywhere, skipping ignored directives', () => {
        const analysis = analyzeScript([
            '#!/bin/bash',
            '#SBATCH -p a100-long',
            '#SBATCH --gres=gpu:a100:1',
            'module load cuda',
            '#SBATCH -p ignored',
            'srun -p h200 --gpus=h200:1 python train.py',
        ]);

        assert.deepEqual(analysis.segments.map(segment => [segment.line, segment.segment.kind, segment.partitions]), [
            [1, 'directive', ['a100-long']],
            [2, 'directive', []],
            [5, 'srun', ['h200']],
        ]);
        assert.deepEqual(analysis.segments[2].gpuTypes, [{ type: 'h200', start: 20, end: 24 }]);
    });
});

function entry(partition: string, types: string[]): PartitionUsageEntry {
    return {
        partition, isDefault: false,
        totalNodes: 1, allocatedNodes: 0, idleNodes: 1, otherNodes: 0,
        totalGpus: 0, availableGpus: 0, allocatedGpus: 0, idleGpus: 0,
        runningJobs: 0, pendingJobs: 0,
        gpuTypes: types.map(type => ({ type, count: 4 })),
    };
}

describe('findGpuTypeProblems', () => {
    const gpuEntries = [entry('a100-long', ['a100']), entry('h200', ['h200']), entry('mixed', ['v100', 'a100']), entry('plain', ['generic'])];
    const known = ['a100-long', 'h200', 'mixed', 'plain', 'cpu'];
    const problemsIn = (lines: string[]) => findGpuTypeProblems(analyzeScript(lines), gpuEntries, known);

    it('flags a type the header partition doesn\'t have, at the type\'s columns', () => {
        assert.deepEqual(problemsIn(['#SBATCH -p a100-long', '#SBATCH --gres=gpu:h200:2']), [{
            line: 1, start: 19, end: 23,
            message: 'No h200 GPUs in partition a100-long. The selected partition only has GPUs of type a100.',
        }]);
    });

    it('accepts a type that any of the partitions has, as Slurm picks one that fits', () => {
        assert.deepEqual(problemsIn(['#SBATCH -p a100-long,h200', '#SBATCH --gpus=h200:1']), []);
    });

    it('names every partition and the types they have', () => {
        assert.equal(
            problemsIn(['#SBATCH -p a100-long,mixed', '#SBATCH --gpus=h200:1'])[0].message,
            'No h200 GPUs in partitions a100-long or mixed. The selected partitions only have GPUs of types a100 and v100.',
        );
    });

    it('lists several types of one partition', () => {
        assert.equal(
            problemsIn(['#SBATCH -p mixed', '#SBATCH --gpus=h200:1'])[0].message,
            'No h200 GPUs in partition mixed. The selected partition only has GPUs of types a100 and v100.',
        );
    });

    it('joins three or more partitions naturally', () => {
        assert.equal(
            problemsIn(['#SBATCH -p a100-long,mixed,plain', '#SBATCH --gpus=h200:1'])[0].message,
            'No h200 GPUs in partitions a100-long, mixed or plain. The selected partitions only have GPUs of types a100 and v100.',
        );
    });

    it('explains a GPU request on a partition without GPUs', () => {
        assert.equal(
            problemsIn(['#SBATCH -p cpu', '#SBATCH --gres=gpu:a100:1'])[0].message,
            'No a100 GPUs in partition cpu. The selected partition has no GPUs.',
        );
    });

    it('explains a typed request on a partition with only untyped GPUs', () => {
        assert.equal(
            problemsIn(['#SBATCH -p plain', '#SBATCH --gres=gpu:a100:1'])[0].message,
            'No a100 GPUs in partition plain. The selected partition only has GPUs without a type, so request a count instead, e.g. --gpus=2.',
        );
    });

    it('checks job steps against their own partition, or the header\'s', () => {
        const lines = ['#SBATCH -p a100-long', 'srun --gpus=h200:1 x', 'srun -p h200 --gpus=h200:1 x'];
        assert.deepEqual(problemsIn(lines).map(problem => problem.line), [1]);
    });

    it('leaves sbatch lines without their own partition alone', () => {
        assert.deepEqual(problemsIn(['#SBATCH -p a100-long', 'sbatch --gres=gpu:h200:1 other.sh']), []);
    });

    it('leaves requests alone when no partition is named or one is unknown', () => {
        assert.deepEqual(problemsIn(['#SBATCH --gres=gpu:h200:1']), []);
        assert.deepEqual(problemsIn(['#SBATCH -p a10-long', '#SBATCH --gres=gpu:h200:1']), []);
    });

    it('ignores directives sbatch ignores, after the first command', () => {
        assert.deepEqual(problemsIn(['#SBATCH -p a100-long', 'echo start', '#SBATCH --gres=gpu:h200:1']), []);
    });

    it('accepts bare GPU counts', () => {
        assert.deepEqual(problemsIn(['#SBATCH -p a100-long', '#SBATCH --gpus=4']), []);
    });
});
