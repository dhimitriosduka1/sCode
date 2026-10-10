import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildFairShareLookup,
    findJobPriorityFactors,
    formatFairShareAccounts,
    formatFairShareFactor,
    formatFairShareHeaderLabel,
    formatFairShareTooltip,
    formatJobPriorityDetails,
    getDominantPriorityComponent,
    getFairShareSummary,
    rankJobAccounts,
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

    it('keeps every account of a user spanning several, highest standing first', () => {
        const lookup = buildFairShareLookup([
            entry('nova42', 0.14, 'atlas_lab'),
            entry('nova42', 0.87, 'vision_lab'),
            entry('nova42', 0.31, 'data_lab'),
        ]);

        assert.deepEqual(getFairShareSummary(lookup, 'nova42')?.accounts.map(a => a.account), ['vision_lab', 'data_lab', 'atlas_lab']);
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
        const summary = getFairShareSummary(buildFairShareLookup([entry('nova42', 0.71)]), 'nova42')!;

        assert.equal(formatFairShareHeaderLabel(summary), '⚖️ Your fair share: 0.710');
    });
});

describe('choosing the account whose fair share applies', () => {
    const lookup = buildFairShareLookup([
        entry('nova42', 0.14, 'atlas_lab'),
        entry('nova42', 0.87, 'vision_lab'),
        entry('nova42', 0.31, 'data_lab'),
        entry('solo', 0.5, 'climate_lab'),
    ]);
    const chosen = (hints: Parameters<typeof getFairShareSummary>[2]) => {
        const summary = getFairShareSummary(lookup, 'nova42', hints)!;
        return [summary.account, summary.fairShareFactor, summary.source];
    };

    it('uses the account the user\'s jobs run under, even if another stands higher', () => {
        assert.deepEqual(chosen({ jobAccounts: ['atlas_lab'], defaultAccount: 'data_lab' }), ['atlas_lab', 0.14, 'jobs']);
    });

    it('takes the first job account the user has an association in', () => {
        assert.deepEqual(chosen({ jobAccounts: ['other_lab', 'data_lab'] }), ['data_lab', 0.31, 'jobs']);
    });

    it('falls back to the default account without jobs', () => {
        assert.deepEqual(chosen({ jobAccounts: [], defaultAccount: 'data_lab' }), ['data_lab', 0.31, 'default']);
    });

    it('falls back to the highest standing, and says so, with nothing to go by', () => {
        assert.deepEqual(chosen({}), ['vision_lab', 0.87, 'highest']);
        assert.deepEqual(chosen({ defaultAccount: 'gone_lab' }), ['vision_lab', 0.87, 'highest']);
    });

    it('needs no hints for a single account', () => {
        const summary = getFairShareSummary(lookup, 'solo')!;
        assert.deepEqual([summary.account, summary.source], ['climate_lab', 'only']);
    });
});

describe('rankJobAccounts', () => {
    it('orders accounts by how many jobs run under each', () => {
        assert.deepEqual(rankJobAccounts([
            { account: 'b' }, { account: 'a' }, { account: 'b' }, {}, { account: 'c' },
        ]), ['b', 'a', 'c']);
    });
});

describe('fair share tooltips', () => {
    const lookup = buildFairShareLookup([
        entry('nova42', 0.142857, 'atlas_lab'),
        entry('nova42', 0.642857, 'vision_lab'),
        entry('solo', 0.5, 'climate_lab'),
    ]);

    it('explains the factor and lists each account, marking the one shown and why', () => {
        const summary = getFairShareSummary(lookup, 'nova42', { jobAccounts: ['atlas_lab'] })!;
        assert.equal(formatFairShareTooltip(summary), [
            '**Your fair share**',
            '',
            '1.000 is the highest standing on the cluster; lower means your jobs queue behind more users\'.',
            '',
            '**Your accounts**',
            '- vision_lab: 0.643',
            '- atlas_lab: 0.143 (shown: the account your jobs run under)',
        ].join('\n'));
    });

    it('explains a default-account or highest-standing choice', () => {
        assert.match(formatFairShareTooltip(getFairShareSummary(lookup, 'nova42', { defaultAccount: 'atlas_lab' })!), /atlas_lab: 0\.143 \(shown: your default account\)/);
        assert.match(formatFairShareTooltip(getFairShareSummary(lookup, 'nova42')!), /vision_lab: 0\.643 \(shown: your highest; no jobs or default account to go by\)/);
    });

    it('skips the account list for a single account', () => {
        assert.doesNotMatch(formatFairShareTooltip(getFairShareSummary(lookup, 'solo')!), /Your accounts/);
    });

    it('formats a user\'s fair share across accounts, the applicable one first', () => {
        assert.equal(formatFairShareAccounts(getFairShareSummary(lookup, 'solo')!), '0.500');
        assert.equal(formatFairShareAccounts(getFairShareSummary(lookup, 'nova42', { jobAccounts: ['atlas_lab'] })!), 'atlas_lab 0.143 · vision_lab 0.643');
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
