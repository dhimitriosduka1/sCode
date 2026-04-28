import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { ClusterAccountOverviewEntry } from '../slurmService';
import {
    formatClusterAccountOverviewDescription,
    formatClusterAccountOverviewTooltipMarkdown,
    formatClusterAccountOverviewTrailingDescription,
    formatClusterGpuShareValue,
    getClusterAccountOverviewLabel,
    getTotalClusterOverviewGpuCount,
    sortClusterAccountOverviewEntries,
} from '../clusterOverviewRanking';

function accountEntry(
    account: string,
    gpuCount: number,
    gpuJobCount: number,
): ClusterAccountOverviewEntry {
    return {
        account,
        gpuCount,
        gpuJobCount,
        gpuTypes: gpuCount > 0 ? [{ type: 'a100', count: gpuCount }] : [],
        users: [
            { username: `${account}-user`, gpuCount, gpuJobCount },
        ],
    };
}

describe('cluster overview ranking', () => {
    it('sorts Slurm accounts by GPUs, then GPU jobs, then account name', () => {
        const entries = [
            accountEntry('z_inst', 4, 1),
            accountEntry('a_inst', 4, 3),
            accountEntry('b_inst', 4, 3),
            accountEntry('small_inst', 1, 1),
        ];

        assert.deepEqual(sortClusterAccountOverviewEntries(entries).map(entry => entry.account), [
            'a_inst',
            'b_inst',
            'z_inst',
            'small_inst',
        ]);
    });

    it('computes total account GPU usage', () => {
        assert.equal(getTotalClusterOverviewGpuCount([
            accountEntry('a_inst', 4, 1),
            accountEntry('b_inst', 2, 1),
        ]), 6);
    });

    it('formats account rows and trailing GPU share', () => {
        const entry = accountEntry('vision_lab', 6, 2);

        assert.equal(getClusterAccountOverviewLabel(entry, 1), '1. vision_lab');
        assert.equal(formatClusterAccountOverviewDescription(entry), '6 GPUs · 2 GPU jobs');
        assert.equal(formatClusterAccountOverviewTrailingDescription(entry, 9), '●●●●●○○○ 67%');
    });

    it('formats readable cluster GPU share values', () => {
        assert.equal(formatClusterGpuShareValue(1, 9), '1 GPU of 9 GPUs (11%)');
        assert.equal(formatClusterGpuShareValue(2, 0), '2 GPUs of 0 GPUs');
    });

    it('formats account overview tooltip markdown with top users and GPU types', () => {
        const tooltip = formatClusterAccountOverviewTooltipMarkdown({
            account: 'vision_lab',
            gpuCount: 6,
            gpuJobCount: 2,
            gpuTypes: [
                { type: 'a100', count: 4 },
                { type: 'h200', count: 2 },
            ],
            users: [
                { username: 'alice', gpuCount: 2, gpuJobCount: 1 },
                { username: 'bob', gpuCount: 4, gpuJobCount: 1 },
            ],
        }, 9);

        assert.equal(tooltip, [
            '**vision_lab**',
            '',
            '6 GPUs · 2 GPU jobs',
            '',
            '- **Cluster GPU share:** 6 GPUs of 9 GPUs (67%)',
            '- **GPU types:** a100: 4 GPUs, h200: 2 GPUs',
            '',
            '**Top users**',
            '- bob: 4 GPUs · 1 GPU job',
            '- alice: 2 GPUs · 1 GPU job',
        ].join('\n'));
    });
});
