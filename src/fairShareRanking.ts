import { extractBaseJobId, FairShareEntry, JobPriorityFactors } from './slurmService';
import { formatTooltipMarkdown, TooltipDetail } from './tooltipMarkdown';

/** A user's fair share in one of their accounts. */
export interface AccountFairShare {
    account: string;
    fairShareFactor: number;
}

/** Why a summary shows the account it does. */
export type FairShareAccountSource = 'only' | 'jobs' | 'default' | 'highest';

/**
 * A user's fair share standing, flattened from the `sshare` association tree
 * into what a view needs to render: the account that applies to their jobs,
 * and every account they have, since each one has its own standing.
 */
export interface FairShareSummary {
    username: string;
    account: string;
    fairShareFactor: number;
    source: FairShareAccountSource;
    /** Every account the user has, highest standing first */
    accounts: AccountFairShare[];
}

/** A user's associations, by lowercased username. */
export type FairShareLookup = Map<string, { username: string; accounts: AccountFairShare[] }>;

/**
 * Build a username -> associations lookup from raw `sshare` rows. Account-level
 * rows are dropped; only user associations carry a Fair Tree ranking.
 */
export function buildFairShareLookup(entries: FairShareEntry[]): FairShareLookup {
    const lookup: FairShareLookup = new Map();

    for (const entry of entries) {
        if (!entry.username) {
            continue;
        }

        const key = entry.username.toLowerCase();
        const user = lookup.get(key) ?? { username: entry.username, accounts: [] };
        user.accounts.push({ account: entry.account, fairShareFactor: entry.fairShareFactor });
        lookup.set(key, user);
    }

    for (const user of lookup.values()) {
        user.accounts.sort((a, b) => b.fairShareFactor - a.fairShareFactor || a.account.localeCompare(b.account));
    }

    return lookup;
}

/**
 * Which of a user's accounts applies, in the order Slurm would charge a job:
 * the account their jobs actually run under, else their default account,
 * which jobs use unless they pass --account. Only without either does it fall
 * back to the highest standing, which the summary says, as it may overstate.
 */
export function getFairShareSummary(
    lookup: FairShareLookup,
    username: string | undefined,
    hints: { jobAccounts?: string[]; defaultAccount?: string } = {},
): FairShareSummary | undefined {
    const user = username ? lookup.get(username.trim().toLowerCase()) : undefined;
    if (!user || user.accounts.length === 0) {
        return undefined;
    }

    const find = (account: string | undefined) => user.accounts.find(candidate => candidate.account === account);
    const byJobs = (hints.jobAccounts ?? []).map(find).find(candidate => candidate !== undefined);
    const byDefault = find(hints.defaultAccount);

    let chosen = user.accounts[0];
    let source: FairShareAccountSource = 'highest';
    if (user.accounts.length === 1) {
        source = 'only';
    } else if (byJobs) {
        chosen = byJobs;
        source = 'jobs';
    } else if (byDefault) {
        chosen = byDefault;
        source = 'default';
    }

    return {
        username: user.username,
        account: chosen.account,
        fairShareFactor: chosen.fairShareFactor,
        source,
        accounts: user.accounts,
    };
}

/**
 * Accounts ordered by how many of the given jobs run under each, so the
 * account most of a user's work is charged to comes first.
 */
export function rankJobAccounts(jobs: { account?: string }[]): string[] {
    const counts = new Map<string, number>();
    for (const { account } of jobs) {
        if (account) {
            counts.set(account, (counts.get(account) ?? 0) + 1);
        }
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([account]) => account);
}

/**
 * The Fair Tree factor, in [0, 1]. The highest-ranked user on the cluster
 * scores 1.0, so a lower value means jobs queue further back.
 *
 * Shown to three decimals because Fair Tree spaces factors by
 * 1 / user_association_count — on a cluster with a few hundred associations
 * adjacent users differ in the third decimal, and rounding to two made
 * genuinely different users look identical.
 */
export function formatFairShareFactor(factor: number): string {
    if (!Number.isFinite(factor)) {
        return '—';
    }

    return factor.toFixed(3);
}

/** Label for the Active Jobs header row. */
export function formatFairShareHeaderLabel(summary: FairShareSummary): string {
    return `⚖️ Your fair share: ${formatFairShareFactor(summary.fairShareFactor)}`;
}

const ACCOUNT_SOURCE_NOTES: Record<Exclude<FairShareAccountSource, 'only'>, string> = {
    jobs: 'the account your jobs run under',
    default: 'your default account',
    highest: 'your highest; no jobs or default account to go by',
};

/**
 * Tooltip for the Active Jobs header row: how to read the factor and, for
 * users with several accounts, each account's standing with the shown one marked.
 */
export function formatFairShareTooltip(summary: FairShareSummary): string {
    const note = summary.source === 'only' ? undefined : ACCOUNT_SOURCE_NOTES[summary.source];
    const sections = note === undefined ? [] : [{
        title: 'Your accounts',
        lines: summary.accounts.map(({ account, fairShareFactor }) => {
            const line = `${account}: ${formatFairShareFactor(fairShareFactor)}`;
            return account === summary.account ? `${line} (shown: ${note})` : line;
        }),
    }];

    return formatTooltipMarkdown({
        title: 'Your fair share',
        summary: '1.000 is the highest standing on the cluster; lower means your jobs queue behind more users\'.',
        sections,
    });
}

/**
 * A user's fair share as one value: the factor alone for a single account,
 * otherwise each account, the one their jobs run under first.
 */
export function formatFairShareAccounts(summary: FairShareSummary): string {
    if (summary.accounts.length === 1) {
        return formatFairShareFactor(summary.fairShareFactor);
    }

    const ordered = [
        ...summary.accounts.filter(({ account }) => account === summary.account),
        ...summary.accounts.filter(({ account }) => account !== summary.account),
    ];
    return ordered.map(({ account, fairShareFactor }) => `${account} ${formatFairShareFactor(fairShareFactor)}`).join(' · ');
}

const PRIORITY_COMPONENT_LABELS: { key: keyof JobPriorityFactors; label: string }[] = [
    { key: 'fairshare', label: 'Fair share' },
    { key: 'age', label: 'Age' },
    { key: 'qos', label: 'QOS' },
    { key: 'partition', label: 'Partition' },
    { key: 'jobSize', label: 'Job size' },
];

/**
 * Tooltip rows for a pending job's priority breakdown. Components a site has
 * disabled report 0 and are omitted rather than shown as empty weight.
 */
export function formatJobPriorityDetails(factors: JobPriorityFactors): TooltipDetail[] {
    const details: TooltipDetail[] = [
        { label: 'Priority', value: factors.priority },
    ];

    for (const component of PRIORITY_COMPONENT_LABELS) {
        const value = factors[component.key];
        if (typeof value === 'number' && value > 0) {
            details.push({ label: `${component.label} weight`, value });
        }
    }

    return details;
}

/**
 * Look up a job's priority components, tolerating the job ID mismatch between
 * squeue and sprio.
 *
 * squeue reports a pending array as `91004_[3-10%2]` (throttle included), while
 * sprio reports individual tasks like `91004_3`, so an exact match never
 * succeeds for the array row. Falling back to the base job ID lets the array
 * show a representative task — every task of an array shares the same fair
 * share, QOS and partition weights, so only the age term can drift.
 */
export function findJobPriorityFactors(
    factors: Map<string, JobPriorityFactors> | undefined,
    jobId: string,
): JobPriorityFactors | undefined {
    if (!factors) {
        return undefined;
    }

    const exact = factors.get(jobId);
    if (exact) {
        return exact;
    }

    const baseJobId = extractBaseJobId(jobId);
    for (const [key, value] of factors) {
        if (extractBaseJobId(key) === baseJobId) {
            return value;
        }
    }

    return undefined;
}

/**
 * Names the component contributing most to a job's priority, so the tooltip
 * can say what its priority mostly rests on.
 */
export function getDominantPriorityComponent(factors: JobPriorityFactors): string | undefined {
    let dominant: { label: string; value: number } | undefined;

    for (const component of PRIORITY_COMPONENT_LABELS) {
        const value = factors[component.key];
        if (typeof value === 'number' && value > 0 && (!dominant || value > dominant.value)) {
            dominant = { label: component.label, value };
        }
    }

    return dominant?.label;
}
