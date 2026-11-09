import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildPartitionUpdateCommand,
    buildPartitionUpdateTarget,
    parsePartitionNames,
    pendingRowsUsePartitions,
    samePartitionSet,
    SlurmService,
    splitPartitionList,
} from '../slurmService';

describe('partition update helpers', () => {
    it('lists sinfo partitions once each, sorted, without blank or odd names', () => {
        assert.deepEqual(
            parsePartitionNames('gpu_48g.q\ncpu.q\n\ngpu_48g.q\n  gpu_24g.q  \nbad name\n$(rm)\n'),
            ['cpu.q', 'gpu_24g.q', 'gpu_48g.q'],
        );
    });

    it('drops the throttle from an array pending record and keeps other ids', () => {
        assert.equal(buildPartitionUpdateTarget('10582386_[118-280%2]'), '10582386_[118-280]');
        assert.equal(buildPartitionUpdateTarget('10582386_[1,3,5-9%10]'), '10582386_[1,3,5-9]');
        assert.equal(buildPartitionUpdateTarget('10582386_[118-280]'), '10582386_[118-280]');
        assert.equal(buildPartitionUpdateTarget('10582829'), '10582829');
        assert.equal(buildPartitionUpdateTarget('10582386_7'), '10582386_7');
    });

    it('quotes the bracketed id so the shell does not glob it', () => {
        assert.equal(
            buildPartitionUpdateCommand('123_[4-9]', ['cpu.q', 'gpu_24g.q']),
            "scontrol update JobId='123_[4-9]' Partition='cpu.q,gpu_24g.q'",
        );
    });

    it('splits a job partition column and compares sets regardless of order', () => {
        assert.deepEqual(splitPartitionList('cpu.q, gpu_24g.q'), ['cpu.q', 'gpu_24g.q']);
        assert.deepEqual(splitPartitionList('N/A'), []);
        assert.equal(samePartitionSet(['a', 'b'], ['b', 'a']), true);
        assert.equal(samePartitionSet(['a'], ['a', 'b']), false);
    });

    it('checks the pending rows of a job after the array record shrank, split or merged', () => {
        // Shapes squeue printed on Slurm 21.08.5 after partial partition updates
        const stdout = '10591964_[0-2,5]|gpu_24g.q\n10591964_3|cpu.q,gpu_24g.q\n10591480|cpu.q\n';
        assert.equal(pendingRowsUsePartitions(stdout, '10591964_[1-5%1]', ['gpu_24g.q', 'cpu.q']), true);
        assert.equal(pendingRowsUsePartitions(stdout, '10591964_[1-5%1]', ['gpu_24g.q']), true);
        assert.equal(pendingRowsUsePartitions(stdout, '10591964_[1-5%1]', ['gpu_48g.q']), false);
        assert.equal(pendingRowsUsePartitions(stdout, '10591480', ['cpu.q']), true);
        assert.equal(pendingRowsUsePartitions(stdout, '10591480', ['gpu_24g.q']), false);
        assert.equal(pendingRowsUsePartitions(stdout, '10591481', ['cpu.q']), false);
    });

});

describe('SlurmService partition update', () => {
    it('sends the throttle-free array id to scontrol', async () => {
        const commands: string[] = [];
        const service = new SlurmService(undefined, undefined, async (command) => {
            commands.push(command);
            return { stdout: '', stderr: '' };
        }, () => false);

        const result = await service.updateJobPartition('10582386_[118-280%2]', ['gpu_24g.q', 'cpu.q']);

        assert.equal(result.success, true);
        assert.deepEqual(commands, ["scontrol update JobId='10582386_[118-280]' Partition='gpu_24g.q,cpu.q'"]);
    });

    it('reports success when scontrol fails on started tasks but squeue shows the move', async () => {
        const service = new SlurmService(undefined, undefined, async (command) => {
            if (command.startsWith('scontrol')) {
                throw new Error('10591479_1: Job is no longer pending execution');
            }
            return { stdout: '10591479_[2-3%1]|gpu_24g.q\n', stderr: '' };
        }, () => false);

        const result = await service.updateJobPartition('10591479_[1-3%1]', ['gpu_24g.q']);

        assert.equal(result.success, true);
        assert.match(result.message, /already started/);
    });

    it('does not use the array wording for a single job confirmed by squeue', async () => {
        const service = new SlurmService(undefined, undefined, async (command) => {
            if (command.startsWith('scontrol')) {
                throw new Error('slurm_update error: Socket timed out on send/recv operation');
            }
            return { stdout: '10591480|gpu_24g.q\n', stderr: '' };
        }, () => false);

        const result = await service.updateJobPartition('10591480', ['gpu_24g.q']);

        assert.equal(result.success, true);
        assert.doesNotMatch(result.message, /already started/);
    });

    it('reports failure when squeue does not show the new partition', async () => {
        const service = new SlurmService(undefined, undefined, async (command) => {
            if (command.startsWith('scontrol')) {
                throw new Error('Invalid partition name specified');
            }
            return { stdout: '10591480|cpu.q\n', stderr: '' };
        }, () => false);

        const result = await service.updateJobPartition('10591480', ['gpu_24g.q']);

        assert.equal(result.success, false);
        assert.match(result.message, /Invalid partition name specified/);
    });

    it('refuses odd partition names before running anything', async () => {
        const service = new SlurmService(undefined, undefined, async (command) => {
            throw new Error(`Unexpected command: ${command}`);
        }, () => false);

        const result = await service.updateJobPartition('123', ['cpu.q; rm -rf ~']);

        assert.equal(result.success, false);
        assert.match(result.message, /Invalid partition name/);
    });

    it('moves a pending mock job and lists mock partitions without shell commands', async () => {
        const service = new SlurmService(undefined, undefined, async (command) => {
            throw new Error(`Unexpected command in mock mode: ${command}`);
        }, () => true);

        const names = await service.getPartitionNames();
        assert.ok(names.length > 0);

        const pending = (await service.getJobs()).find(job => job.state === 'PD');
        assert.ok(pending);
        const result = await service.updateJobPartition(pending.jobId, [names[0]]);
        assert.equal(result.success, true);
        const after = (await service.getJobs()).find(job => job.jobId === pending.jobId);
        assert.equal(after?.partition, names[0]);
    });
});
