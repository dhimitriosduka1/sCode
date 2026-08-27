import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildFairShareLookup,
    findJobPriorityFactors,
    formatFairShareFactor,
    formatFairShareHeaderLabel,
    formatJobPriorityDetails,
    getDominantPriorityComponent,
    getFairShareSummary,
} from '../fairShareRanking';
import { FairShareEntry, JobPriorityFactors } from '../slurmService';

function entry(
    username: string,
    fairShareFactor: number,
    account: string = 'atlas_lab',
): FairShareEntry {
    return { account, username, fairShareFactor };
}

function factors(overrides: Partial<JobPriorityFactors> = {}): JobPriorityFactors {
    return {
        jobId: '91002',
        priority: 10432,
        age: 1580,
        fairshare: 2104,
        jobSize: 120,
        partition: 748,
        qos: 6000,
        ...overrides,
    };
}

describe('buildFairShareLookup', () => {
    it('indexes user rows by lowercased username', () => {
        const lookup = buildFairShareLookup([entry('NoVa42', 0.14)]);

        assert.equal(lookup.size, 1);
        assert.equal(getFairShareSummary(lookup, 'nova42')?.username, 'NoVa42');
        assert.equal(getFairShareSummary(lookup, 'NOVA42')?.fairShareFactor, 0.14);
    });

    it('drops account-level rows, which carry no Fair Tree user ranking', () => {
        const lookup = buildFairShareLookup([
            entry('', 1),
            entry('nova42', 0.14),
        ]);

        assert.equal(lookup.size, 1);
        assert.ok(lookup.has('nova42'));
    });

    it('keeps the strongest association when a user spans several accounts', () => {
        const lookup = buildFairShareLookup([
            entry('nova42', 0.14, 'atlas_lab'),
            entry('nova42', 0.87, 'vision_lab'),
            entry('nova42', 0.31, 'data_lab'),
        ]);

        const summary = getFairShareSummary(lookup, 'nova42');
        assert.equal(summary?.fairShareFactor, 0.87);
        assert.equal(summary?.account, 'vision_lab');
    });

    it('returns undefined for unknown or missing usernames', () => {
        const lookup = buildFairShareLookup([entry('nova42', 0.14)]);

        assert.equal(getFairShareSummary(lookup, 'ghost'), undefined);
        assert.equal(getFairShareSummary(lookup, undefined), undefined);
        assert.equal(getFairShareSummary(lookup, '  '), undefined);
    });
});

describe('fair share formatting', () => {
    it('formats the factor to three decimals', () => {
        assert.equal(formatFairShareFactor(0.142857), '0.143');
        assert.equal(formatFairShareFactor(1), '1.000');
        assert.equal(formatFairShareFactor(0), '0.000');
    });

    // Fair Tree spaces adjacent users by 1 / user_association_count, which is
    // ~0.0037 on a 270-association cluster — two decimals collapsed them.
    it('keeps adjacent users distinguishable', () => {
        assert.notEqual(formatFairShareFactor(0.470370), formatFairShareFactor(0.474074));
        assert.equal(formatFairShareFactor(0.470370), '0.470');
        assert.equal(formatFairShareFactor(0.474074), '0.474');
    });

    it('falls back to a dash for a non-finite factor', () => {
        assert.equal(formatFairShareFactor(Infinity), '—');
        assert.equal(formatFairShareFactor(NaN), '—');
    });

    it('labels the header row with the factor alone', () => {
        const summary = buildFairShareLookup([entry('nova42', 0.71)]).get('nova42')!;

        assert.equal(formatFairShareHeaderLabel(summary), '⚖️ Your fair share: 0.710');
    });
});

describe('findJobPriorityFactors', () => {
    // squeue reports a pending array as 91004_[3-10%2]; sprio reports tasks.
    const map = new Map([
        ['91002', factors({ jobId: '91002' })],
        ['91004_3', factors({ jobId: '91004_3', priority: 8890 })],
    ]);

    it('matches a plain job by exact id', () => {
        assert.equal(findJobPriorityFactors(map, '91002')?.jobId, '91002');
    });

    it('matches an array row through its base job id', () => {
        assert.equal(findJobPriorityFactors(map, '91004_[3-10%2]')?.jobId, '91004_3');
        assert.equal(findJobPriorityFactors(map, '91004_[3-10]')?.jobId, '91004_3');
        assert.equal(findJobPriorityFactors(map, '91004')?.jobId, '91004_3');
    });

    it('prefers an exact match over the base id fallback', () => {
        const withBoth = new Map([
            ['91004_5', factors({ jobId: '91004_5', priority: 1 })],
            ['91004_3', factors({ jobId: '91004_3', priority: 2 })],
        ]);

        assert.equal(findJobPriorityFactors(withBoth, '91004_3')?.priority, 2);
    });

    it('does not match an unrelated job that shares a prefix', () => {
        assert.equal(findJobPriorityFactors(map, '910020'), undefined);
        assert.equal(findJobPriorityFactors(map, '91003'), undefined);
    });

    it('handles a missing map', () => {
        assert.equal(findJobPriorityFactors(undefined, '91002'), undefined);
    });
});

describe('job priority breakdown', () => {
    it('lists the total priority followed by the active components', () => {
        const details = formatJobPriorityDetails(factors());

        assert.deepEqual(details[0], { label: 'Priority', value: 10432 });
        assert.deepEqual(
            details.slice(1).map(detail => detail.label),
            ['Fair share weight', 'Age weight', 'QOS weight', 'Partition weight', 'Job size weight'],
        );
    });

    it('omits components the site has disabled', () => {
        const details = formatJobPriorityDetails(factors({ qos: 0, partition: 0, jobSize: 0 }));

        assert.deepEqual(
            details.map(detail => detail.label),
            ['Priority', 'Fair share weight', 'Age weight'],
        );
    });

    it('names the component contributing most to the priority', () => {
        assert.equal(getDominantPriorityComponent(factors()), 'QOS');
        assert.equal(getDominantPriorityComponent(factors({ qos: 0 })), 'Fair share');
        assert.equal(getDominantPriorityComponent(factors({ qos: 0, fairshare: 0 })), 'Age');
    });

    it('names nothing when every component is zero', () => {
        const empty = factors({ age: 0, fairshare: 0, jobSize: 0, partition: 0, qos: 0 });

        assert.equal(getDominantPriorityComponent(empty), undefined);
    });
});
