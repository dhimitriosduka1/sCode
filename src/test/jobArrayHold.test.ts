import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countJobs } from '../jobCount';
import { arrayTaskIndices, parseArrayTaskRanges, readArrayTaskList, validateArrayTaskSelection } from '../jobArrayTasks';
import { isJobHeld, SlurmService } from '../slurmService';

describe('Array task selection', () => {
    it('accepts the formats supported by Hold, Release, and Cancel', () => {
        for (const input of ['3', '1,3,5', '0-10', '0-10:2']) {
            assert.equal(validateArrayTaskSelection(input, { minIndex: 0, maxIndex: 10 }), undefined);
        }
        for (const input of ['', '1,1', '0-10:0', '5-2', '-1', '*', '1;2', '9007199254740992']) {
            assert.ok(validateArrayTaskSelection(input), input);
        }
        assert.ok(validateArrayTaskSelection('0-12', { minIndex: 1, maxIndex: 10 }));
        assert.equal(readArrayTaskList('123_[0-10:2%3]'), '0-10:2');
    });
});

describe('Array task selection lists', () => {
    it('accepts lists that mix single indices, ranges and stepped ranges', () => {
        for (const input of ['1-3,5', '0-10:2,15', '2,4-6', '0-4:2,1-5:2']) {
            assert.equal(validateArrayTaskSelection(input, { minIndex: 0, maxIndex: 20 }), undefined, input);
        }
    });

    it('rejects indices that appear twice, also inside ranges', () => {
        for (const input of ['1-3,2', '0-10:2,4', '1-5,5-9', '3,3']) {
            assert.equal(validateArrayTaskSelection(input), 'Duplicate indices detected', input);
        }
        // 5 is odd, so not among 0-10:2
        assert.equal(validateArrayTaskSelection('0-10:2,5'), undefined);
    });

    it('checks bounds against the last index a stepped range reaches', () => {
        assert.equal(validateArrayTaskSelection('1-9:3', { minIndex: 0, maxIndex: 8 }), undefined);
        assert.ok(validateArrayTaskSelection('1-12:3', { minIndex: 0, maxIndex: 8 }));
    });
});

function serviceWithPendingRows(stdout: string) {
    const commands: string[] = [];
    const service = new SlurmService(undefined, undefined, async command => {
        commands.push(command);
        if (command.startsWith('env SLURM_BITSTR_LEN=0 squeue -u $USER --states=PD')) {
            return { stdout, stderr: '' };
        }
        if (command.startsWith('scontrol hold ') || command.startsWith('scontrol release ')) {
            return { stdout: '', stderr: '' };
        }
        throw new Error(`Unexpected command: ${command}`);
    });
    return { service, commands };
}

describe('Array hold commands', () => {
    for (const [selection, target, count] of [
        ['3', '700_3', 1],
        ['1,3,5', '700_[1,3,5]', 3],
        ['2-6', '700_[2-6]', 5],
        ['1-6:2', '700_[1,3,5]', 3],
    ] as const) {
        it(`holds only the selected indices for ${selection}`, async () => {
            const { service, commands } = serviceWithPendingRows('700_[0-10%2]|Priority\n700_11|JobHeldAdmin');
            const id = /^\d+$/.test(selection) ? `700_${selection}` : `700_[${selection}]`;
            const result = await service.holdJob(id);

            assert.equal(result.success, true);
            assert.match(result.message, new RegExp(`Held ${count} task`));
            assert.equal(commands[1], `scontrol hold '${target}'`);
        });
    }

    it('holds every unheld pending row of the chosen array', async () => {
        const { service, commands } = serviceWithPendingRows([
            '700_[0-8%2]|Priority', '700_9|Resources', '700_10|JobHeldUser', '700_11|JobHeldAdmin', '701|Resources',
        ].join('\n'));

        assert.deepEqual(await service.holdArrayTasks('700'), {
            success: true, message: 'Held 10 tasks in array 700.',
        });
        assert.equal(commands[1], "scontrol hold '700_[0-8]' '700_9'");
    });

    it('leaves the rows it is told to skip, such as tasks that will never run, when holding all', async () => {
        const { service, commands } = serviceWithPendingRows('700_[0-3]|Priority\n700_[4-5]|Dependency\n700_6|Resources');
        assert.deepEqual(await service.holdArrayTasks('700', undefined, ['700_[4-5]']), {
            success: true, message: 'Held 5 tasks in array 700.',
        });
        assert.equal(commands[1], "scontrol hold '700_[0-3]' '700_6'");
    });

    it('says there is nothing to hold when every pending row is skipped', async () => {
        const { service, commands } = serviceWithPendingRows('700_[4-5]|Dependency');
        assert.equal((await service.holdArrayTasks('700', undefined, ['700_[4-5]'])).success, false);
        assert.equal(commands.some(command => command.startsWith('scontrol hold ')), false);
    });

    it('accepts a Slurm row containing mixed task ranges and a throttle', async () => {
        const { service, commands } = serviceWithPendingRows('700_[0,2-6:2,9%2]|Resources');
        const result = await service.holdJob('700_[0,2-6:2,9%2]');
        assert.equal(result.success, true);
        assert.equal(result.message, 'Held 5 tasks in array 700.');
        assert.equal(commands[1], "scontrol hold '700_[0,2,4,6,9]'");
    });

    it('splits a large stepped mask across commands while preserving every index exactly once', async () => {
        const { service, commands } = serviceWithPendingRows('700_[0-80000:2]|Resources');
        assert.equal((await service.holdArrayTasks('700')).message, 'Held 40001 tasks in array 700.');
        const actions = commands.slice(1);
        assert.ok(actions.length > 1);
        const indices: number[] = [];
        for (const command of actions) {
            assert.ok(command.length <= 32 * 1024);
            for (const [, id] of command.matchAll(/'(700_[^']+)'/g)) {
                for (const index of arrayTaskIndices(parseArrayTaskRanges(readArrayTaskList(id)!))) {
                    indices.push(index);
                }
            }
        }
        assert.deepEqual(indices, Array.from({ length: 40001 }, (_, index) => index * 2));
    });

    it('rejects a selection containing a missing or already held task before sending a hold', async () => {
        for (const selection of ['1-5', '2', '10', '1,1']) {
            const { service, commands } = serviceWithPendingRows('700_[1,3,5]|Priority\n700_2|JobHeldAdmin');
            assert.equal((await service.holdArrayTasks('700', selection)).success, false);
            assert.equal(commands.some(command => command.startsWith('scontrol hold ')), false);
        }
    });

    it('holds all pending jobs and every pending task from each array in the bulk action', async () => {
        const { service, commands } = serviceWithPendingRows([
            '700_[0-8:2%2]|Priority', '700_9|Resources', '701_[2-4]|Resources', '702|Resources', '703|JobHeldAdmin',
        ].join('\n'));

        const result = await service.holdAllPendingJobs();
        assert.equal(result.success, true);
        assert.match(result.message, /\(10 jobs\)/);
        assert.equal(commands[1], "scontrol hold '700_[0,2,4,6,8]' '700_9' '701_[2-4]' '702'");
    });

    it('reports a failed command so the caller can refresh partially changed jobs', async () => {
        const service = new SlurmService(undefined, undefined, async command => {
            if (command.startsWith('scontrol hold ')) {
                throw new Error('Job is no longer pending');
            }
            return { stdout: '700_[0-2]|Priority', stderr: '' };
        });
        const previous = console.error;
        console.error = () => undefined;
        try {
            const result = await service.holdArrayTasks('700', '1');
            assert.equal(result.success, false);
            assert.match(result.message, /Job is no longer pending/);
        } finally {
            console.error = previous;
        }
    });

    it('reads array bounds from grouped rows and separate tasks', async () => {
        const service = new SlurmService(undefined, undefined, async () => ({
            stdout: 'JobId=700 ArrayTaskId=3\nJobId=701 ArrayTaskId=4-20:2%3\n', stderr: '',
        }));
        assert.deepEqual(await service.getJobArrayInfo('700'), { minIndex: 3, maxIndex: 20 });
    });
});

describe('Array hold in mock mode', () => {
    it('splits off selected tasks and preserves the remaining array tasks and total count', async () => {
        const service = new SlurmService(undefined, undefined, undefined, () => true);
        const before = await service.getJobs();
        const countBefore = countJobs(before.map(job => job.jobId));
        assert.equal((await service.holdArrayTasks('91004', '4-8:2')).success, true);
        const after = await service.getJobs();

        const array = after.filter(job => job.jobId.startsWith('91004_'));
        const held = array.filter(job => isJobHeld(job.pendingReason));
        assert.deepEqual(held.map(job => job.jobId), ['91004_[4,6,8%2]']);
        assert.equal(array.find(job => !isJobHeld(job.pendingReason))?.jobId, '91004_[5,7,9-10%2]');
        assert.equal(countJobs(after.map(job => job.jobId)), countBefore);
        assert.deepEqual(after.filter(job => job.state === 'R'), before.filter(job => job.state === 'R'));

        await service.holdAllPendingJobs();
        assert.equal((await service.getJobs()).filter(job => job.state === 'PD').every(job => isJobHeld(job.pendingReason)), true);
    });
});

describe('Array hold in mock mode, as squeue lists it', () => {
    it('puts the selected tasks in one compressed row with the throttle, as squeue does', async () => {
        const service = new SlurmService(undefined, undefined, undefined, () => true);
        const [template] = await service.getJobs();
        (service as unknown as { mockJobs: unknown[] }).mockJobs = [
            { ...template, jobId: '700_[0-20%2]', state: 'PD', pendingReason: 'Priority' },
        ];
        assert.equal((await service.holdArrayTasks('700', '1-19')).success, true);
        assert.deepEqual((await service.getJobs()).map(job => [job.jobId, job.pendingReason]), [
            ['700_[0,20%2]', 'Priority'],
            ['700_[1-19%2]', 'JobHeldUser'],
        ]);
    });
});

describe('Array release commands', () => {
    for (const [selection, target, count] of [
        ['3', '700_3', 1],
        ['1,3,5', '700_[1,3,5]', 3],
        ['2-6', '700_[2-6]', 5],
        ['1-6:2', '700_[1,3,5]', 3],
    ] as const) {
        it(`releases only the selected indices for ${selection}`, async () => {
            const { service, commands } = serviceWithPendingRows('700_[0-10%2]|JobHeldUser\n700_11|Priority');
            const id = /^\d+$/.test(selection) ? `700_${selection}` : `700_[${selection}]`;
            const result = await service.releaseJob(id);
            assert.equal(result.success, true);
            assert.match(result.message, new RegExp(`Released ${count} task`));
            assert.equal(commands[1], `scontrol release '${target}'`);
        });
    }

    it('releases all held tasks in the chosen array', async () => {
        const { service, commands } = serviceWithPendingRows([
            '700_[0-6%2]|JobHeldUser', '700_7|JobHeldAdmin', '700_8|Priority', '701|JobHeldUser',
        ].join('\n'));
        assert.deepEqual(await service.releaseArrayTasks('700'), {
            success: true, message: 'Released 8 tasks in array 700.',
        });
        assert.equal(commands[1], "scontrol release '700_[0-6]' '700_7'");
    });

    it('leaves the held rows it is told to skip when releasing all', async () => {
        const { service, commands } = serviceWithPendingRows('700_[0-3]|JobHeldUser\n700_[4-5]|JobHeldUser');
        assert.equal((await service.releaseArrayTasks('700', undefined, ['700_[4-5]'])).message, 'Released 4 tasks in array 700.');
        assert.equal(commands[1], "scontrol release '700_[0-3]'");
    });

    it('rejects missing or unheld indices before sending the release', async () => {
        for (const selection of ['1-5', '2', '10', '1,1']) {
            const { service, commands } = serviceWithPendingRows('700_[1,3,5]|JobHeldUser\n700_2|Resources');
            assert.equal((await service.releaseArrayTasks('700', selection)).success, false);
            assert.equal(commands.some(command => command.startsWith('scontrol release ')), false);
        }
    });

    it('releases exactly the held rows shown in the tree group', async () => {
        const { service, commands } = serviceWithPendingRows([
            '700_[0-8:2%2]|JobHeldUser', '700_9|JobHeldUser', '701|JobHeldUser', '702|Resources',
        ].join('\n'));
        const result = await service.releaseAllPendingJobs(['700_[0-8:2%2]']);
        assert.equal(result.success, true);
        assert.equal(result.message, 'Released 5 held jobs.');
        assert.equal(commands[1], "scontrol release '700_[0,2,4,6,8]'");
    });

    it('reports Slurm permission failures when releasing admin-held tasks', async () => {
        const service = new SlurmService(undefined, undefined, async command => {
            if (command.startsWith('scontrol release ')) {
                throw new Error('Access/permission denied');
            }
            return { stdout: '700_[0-2]|JobHeldAdmin', stderr: '' };
        });
        const previous = console.error;
        console.error = () => undefined;
        try {
            const result = await service.releaseArrayTasks('700', '1');
            assert.equal(result.success, false);
            assert.match(result.message, /Access\/permission denied/);
        } finally {
            console.error = previous;
        }
    });
});

describe('Array release in mock mode', () => {
    it('releases part of a grouped held row and preserves every remaining hold', async () => {
        const service = new SlurmService(undefined, undefined, undefined, () => true);
        await service.holdAllPendingJobs();
        const before = await service.getJobs();

        assert.equal((await service.releaseArrayTasks('91004', '4-8:2')).success, true);
        const after = await service.getJobs();
        const array = after.filter(job => job.jobId.startsWith('91004_'));
        assert.deepEqual(array.filter(job => !isJobHeld(job.pendingReason)).map(job => job.jobId), ['91004_[4,6,8%2]']);
        assert.equal(isJobHeld(array.find(job => job.jobId === '91004_3')?.pendingReason), true);
        assert.equal(isJobHeld(array.find(job => job.jobId === '91004_[5,7,9-10%2]')?.pendingReason), true);
        assert.equal(isJobHeld(after.find(job => job.jobId === '91002')?.pendingReason), true);
        assert.equal(countJobs(after.map(job => job.jobId)), countJobs(before.map(job => job.jobId)));

        assert.equal((await service.releaseArrayTasks('91004')).success, true);
        assert.equal((await service.getJobs()).filter(job => job.jobId.startsWith('91004_'))
            .every(job => !isJobHeld(job.pendingReason)), true);
    });
});

describe('Hold and release across queue snapshots', () => {
    it('splits a mixed Slurm row for the tree and targets only the eligible tasks for each action', async () => {
        const actions: string[] = [];
        const service = new SlurmService(undefined, undefined, async command => {
            let stdout = '';
            if (command.includes('--array --noheader')) {
                stdout = '700_1|Resources\n700_2|JobHeldUser\n700_3|JobHeldUser\n700_4|Priority';
            } else if (command.includes('--states=PD')) {
                stdout = '700_[1-5%2]|Resources,JobHeldUser,Priority';
            } else if (command.includes('%j|%t')) {
                stdout = '700_[1-5%2]|train|PD|0:00|gpu||1:00|N/A|Resources,JobHeldUser,Priority|lab';
            } else if (command.startsWith('scontrol hold ') || command.startsWith('scontrol release ')) {
                actions.push(command);
            }
            return { stdout, stderr: '' };
        });

        // Task 5 left the pending queue between the compact and expanded reads.
        const rows = await service.getJobs();
        assert.deepEqual(rows.map(row => [row.jobId, row.pendingReason]), [
            ['700_1', 'Resources'], ['700_[2-3%2]', 'JobHeldUser'], ['700_4', 'Priority'],
        ]);
        assert.equal((await service.releaseArrayTasks('700', '1')).success, false);
        assert.equal((await service.holdArrayTasks('700', '2')).success, false);
        assert.equal((await service.holdAllPendingJobs()).success, true);
        assert.equal((await service.releaseArrayTasks('700')).success, true);
        assert.deepEqual(actions, ["scontrol hold '700_1' '700_4'", "scontrol release '700_[2-3]'"]);
    });

    it('keeps a mixed row when none of its tasks are pending any more in the per-task snapshot', async () => {
        const service = new SlurmService(undefined, undefined, async command => {
            let stdout = '';
            if (command.includes('%j|%t')) {
                stdout = '800_[0-3]|sweep|PD|0:00|gpu||1:00|N/A|Priority,DependencyNeverSatisfied|lab';
            }
            // The per-task squeue (--array) finds none of them pending: they started meanwhile
            return { stdout, stderr: '' };
        });
        const rows = await service.getJobs();
        assert.deepEqual(rows.map(row => [row.jobId, row.pendingReason]), [
            ['800_[0-3]', 'Priority,DependencyNeverSatisfied'],
        ]);
    });

    it('splits a mixed row so tasks that will never run get rows of their own', async () => {
        const service = new SlurmService(undefined, undefined, async command => {
            let stdout = '';
            if (command.includes('--array --noheader')) {
                stdout = '800_0|Priority\n800_1|DependencyNeverSatisfied\n800_2|Priority\n800_3|DependencyNeverSatisfied';
            } else if (command.includes('%j|%t')) {
                stdout = '800_[0-3]|sweep|PD|0:00|gpu||1:00|N/A|Priority,DependencyNeverSatisfied|lab';
            }
            return { stdout, stderr: '' };
        });
        const rows = await service.getJobs();
        assert.deepEqual(rows.map(row => [row.jobId, row.pendingReason]), [
            ['800_[0,2]', 'Priority'], ['800_[1,3]', 'DependencyNeverSatisfied'],
        ]);
    });

    it('still lists the jobs when the per-task snapshot fails', async () => {
        const service = new SlurmService(undefined, undefined, async command => {
            if (command.includes('--array --noheader')) {
                throw new Error('squeue: slurm_load_jobs error: Socket timed out');
            }
            const stdout = command.includes('%j|%t')
                ? '800_[0-3]|sweep|PD|0:00|gpu||1:00|N/A|Priority,JobHeldUser|lab\n801|eval|R|0:10|gpu|n1|1:00|N/A|None|lab'
                : '';
            return { stdout, stderr: '' };
        });
        assert.deepEqual((await service.getJobs()).map(row => row.jobId), ['800_[0-3]', '801']);
    });

    it('holds only the jobs shown in the Pending group', async () => {
        const { service, commands } = serviceWithPendingRows([
            '700_[0-3]|Priority', '701|Resources', '702|DependencyNeverSatisfied',
        ].join('\n'));
        const result = await service.holdAllPendingJobs(['700_[0-3]', '701']);
        assert.equal(result.success, true);
        assert.equal(result.message, 'Held 5 pending jobs.');
        assert.equal(commands[1], "scontrol hold '700_[0-3]' '701'");
    });

    it('intersects the displayed selection with the current held indices after Slurm regroups rows', async () => {
        const { service, commands } = serviceWithPendingRows('700_2|JobHeldUser\n700_[4-7%2]|JobHeldUser\n700_3|Priority');
        assert.equal((await service.releaseAllPendingJobs(['700_[2-5%4]'])).message, 'Released 3 held jobs.');
        assert.equal(commands[1], "scontrol release '700_2' '700_[4-5]'");
    });

    it('recognizes the held requeue reason displayed by the cluster', async () => {
        const { service, commands } = serviceWithPendingRows('700_1|user env retrieval failed requeued held\n700_2|Priority');
        assert.equal((await service.releaseArrayTasks('700')).message, 'Released 1 task in array 700.');
        assert.equal(commands[1], "scontrol release '700_1'");
    });

    it('rejects a truncated array ID without sending a command for the base job', async () => {
        const { service, commands } = serviceWithPendingRows('');
        assert.equal((await service.holdJob('700_[1-4,...]')).success, false);
        assert.equal((await service.releaseJob('700_[1-4,...]')).success, false);
        assert.deepEqual(commands, []);
    });
});
