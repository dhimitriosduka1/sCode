import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    parseFairShareNumber,
    parseSprioOutput,
    parseSshareOutput,
    SlurmCommandRunner,
    SlurmService,
} from '../slurmService';

describe('parseFairShareNumber', () => {
    it('parses ordinary decimal values', () => {
        assert.equal(parseFairShareNumber('0.142857'), 0.142857);
        assert.equal(parseFairShareNumber(' 1930000 '), 1930000);
    });

    it('treats inf as a value rather than a parse failure', () => {
        assert.equal(parseFairShareNumber('inf'), Infinity);
        assert.equal(parseFairShareNumber('Infinity'), Infinity);
    });

    it('returns undefined for empty and non-numeric cells', () => {
        assert.equal(parseFairShareNumber(''), undefined);
        assert.equal(parseFairShareNumber('   '), undefined);
        assert.equal(parseFairShareNumber(undefined), undefined);
        assert.equal(parseFairShareNumber('nan'), undefined);
        assert.equal(parseFairShareNumber('parent'), undefined);
    });
});

describe('parseSshareOutput', () => {
    const output = [
        'root||1.000000',
        '  atlas_lab||0.142857',
        '   atlas_lab|nova42|0.142857',
        '  data_lab||1.000000',
        '   data_lab|rune|1.000000',
    ].join('\n');

    it('parses user and account rows, trimming the tree indentation', () => {
        const entries = parseSshareOutput(output);

        assert.equal(entries.length, 5);
        assert.deepEqual(entries[1], { account: 'atlas_lab', username: '', fairShareFactor: 0.142857 });
        assert.deepEqual(entries[2], { account: 'atlas_lab', username: 'nova42', fairShareFactor: 0.142857 });
        assert.deepEqual(entries[4], { account: 'data_lab', username: 'rune', fairShareFactor: 1 });
    });

    it('reads a missing FairShare cell as zero rather than dropping the row', () => {
        const entries = parseSshareOutput('  vision_lab|kawi19');

        assert.equal(entries.length, 1);
        assert.equal(entries[0].username, 'kawi19');
        assert.equal(entries[0].fairShareFactor, 0);
    });

    it('skips blank lines and rows without an account', () => {
        assert.deepEqual(parseSshareOutput(''), []);
        assert.deepEqual(parseSshareOutput('\n   \n'), []);
        assert.deepEqual(parseSshareOutput('|nova42|1'), []);
    });
});

describe('parseSprioOutput', () => {
    it('parses the weighted priority components', () => {
        const factors = parseSprioOutput([
            '91002|10432|1580|2104|120|748|6000',
            '91003| 9315|  640| 2104| 120| 748| 6000',
        ].join('\n'));

        assert.equal(factors.length, 2);
        assert.deepEqual(factors[0], {
            jobId: '91002',
            priority: 10432,
            age: 1580,
            fairshare: 2104,
            jobSize: 120,
            partition: 748,
            qos: 6000,
        });
        // Slurm pads format fields to their default widths.
        assert.equal(factors[1].priority, 9315);
        assert.equal(factors[1].age, 640);
    });

    it('reads disabled priority components as zero', () => {
        const factors = parseSprioOutput('91002|500|500|||||');

        assert.equal(factors[0].fairshare, 0);
        assert.equal(factors[0].qos, 0);
    });

    it('ignores header and non-job lines', () => {
        const factors = parseSprioOutput([
            'JOBID|PRIORITY|AGE|FAIRSHARE|JOBSIZE|PARTITION|QOS',
            '91002|10432|1580|2104|120|748|6000',
        ].join('\n'));

        assert.equal(factors.length, 1);
        assert.equal(factors[0].jobId, '91002');
    });

    it('returns an empty list for empty output', () => {
        assert.deepEqual(parseSprioOutput(''), []);
    });
});

describe('SlurmService fair share', () => {
    function createService(runner: SlurmCommandRunner): SlurmService {
        return new SlurmService(undefined, undefined, runner, () => false);
    }

    it('reports fair share as unavailable when sshare is missing', async () => {
        const service = createService(async () => {
            throw new Error('sshare: command not found');
        });

        const result = await service.getFairShare();

        assert.equal(result.available, false);
        assert.deepEqual(result.entries, []);
    });

    it('caches sshare output across calls until invalidated', async () => {
        let calls = 0;
        const service = createService(async () => {
            calls++;
            return { stdout: '  atlas_lab|nova42|0.5', stderr: '' };
        });

        await service.getFairShare();
        await service.getFairShare();
        assert.equal(calls, 1);

        service.invalidateFairShareCache();
        await service.getFairShare();
        assert.equal(calls, 2);
    });

    it('shares a single in-flight sshare call between concurrent callers', async () => {
        let calls = 0;
        const service = createService(async () => {
            calls++;
            await new Promise(resolve => setImmediate(resolve));
            return { stdout: '  atlas_lab|nova42|0.5', stderr: '' };
        });

        const [first, second] = await Promise.all([service.getFairShare(), service.getFairShare()]);

        assert.equal(calls, 1);
        assert.equal(first.entries.length, 1);
        assert.equal(second.entries.length, 1);
    });

    it('returns priority factors keyed by job id', async () => {
        const service = createService(async () => ({
            stdout: '91002|10432|1580|2104|120|748|6000',
            stderr: '',
        }));

        const factors = await service.getJobPriorityFactors();

        assert.equal(factors.get('91002')?.fairshare, 2104);
        assert.equal(factors.get('nope'), undefined);
    });

    it('returns no priority factors when sprio is missing', async () => {
        const service = createService(async () => {
            throw new Error('sprio: command not found');
        });

        assert.equal((await service.getJobPriorityFactors()).size, 0);
    });

    it('serves mock fair share data without running commands', async () => {
        const service = new SlurmService(undefined, undefined, async (command) => {
            throw new Error(`Unexpected command in mock mode: ${command}`);
        }, () => true);

        const result = await service.getFairShare();
        const factors = await service.getJobPriorityFactors();

        assert.equal(result.available, true);
        assert.ok(result.entries.some(entry => entry.username === 'nova42'));
        assert.ok(factors.size > 0);
    });
});
