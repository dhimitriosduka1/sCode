import { extractBaseJobId, FairShareEntry, JobPriorityFactors } from './slurmService';
import { TooltipDetail } from './tooltipMarkdown';

/**
 * A user's fair share standing, flattened from the `sshare` association tree
 * into the single value a view needs to render.
 */
export interface FairShareSummary {
    username: string;
    account: string;
    fairShareFactor: number;
}

/**
 * Build a username -> fair share lookup from raw `sshare` rows.
 *
 * Account-level rows are dropped; only user associations carry a Fair Tree
 * ranking. A user with associations in several accounts keeps the strongest
 * one, since that is the standing their best-placed jobs schedule against.
 */
export function buildFairShareLookup(entries: FairShareEntry[]): Map<string, FairShareSummary> {
    const lookup = new Map<string, FairShareSummary>();

    for (const entry of entries) {
        if (!entry.username) {
            continue;
        }

        const key = entry.username.toLowerCase();
        const existing = lookup.get(key);

        if (existing && existing.fairShareFactor >= entry.fairShareFactor) {
            continue;
        }

        lookup.set(key, {
            username: entry.username,
            account: entry.account,
            fairShareFactor: entry.fairShareFactor,
        });
    }

    return lookup;
}

export function getFairShareSummary(
    lookup: Map<string, FairShareSummary>,
    username: string | undefined,
): FairShareSummary | undefined {
    const key = username?.trim().toLowerCase();
    return key ? lookup.get(key) : undefined;
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
 * Names the component contributing most to a job's priority, so the tooltip can
 * say what is actually holding the job back.
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
