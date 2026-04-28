import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { PartitionUsageEntry } from '../slurmService';
import {
    formatPartitionUsageDescription,
    formatPartitionUsageSummary,
    formatPartitionUsageTooltipMarkdown,
    getPartitionUsageLabel,
    sortPartitionUsageEntries,
} from '../partitionUsageRanking';

function partitionEntry(overrides: Partial<PartitionUsageEntry>): PartitionUsageEntry {
    const totalGpus = overrides.totalGpus ?? 16;
    return {
        partition: 'gpu',
        isDefault: false,
        totalNodes: 4,
        allocatedNodes: 1,
        idleNodes: 3,
        otherNodes: 0,
        totalGpus,
        availableGpus: overrides.availableGpus ?? totalGpus,
        allocatedGpus: 1,
        idleGpus: 15,
        runningJobs: 1,
        pendingJobs: 0,
        gpuTypes: [{ type: 'h200', count: 16 }],
        ...overrides,
    };
}

describe('partition usage ranking', () => {
    it('sorts partitions from least used to most used', () => {
        const entries = [
            partitionEntry({ partition: 'busy', totalGpus: 8, allocatedGpus: 7, idleGpus: 1 }),
            partitionEntry({ partition: 'idle', totalGpus: 8, allocatedGpus: 1, idleGpus: 7 }),
            partitionEntry({ partition: 'medium', totalGpus: 8, allocatedGpus: 4, idleGpus: 4 }),
        ];

        assert.deepEqual(sortPartitionUsageEntries(entries).map(entry => entry.partition), [
            'idle',
            'medium',
            'busy',
        ]);
    });

    it('uses pending job pressure as the first tie-breaker for equal GPU load', () => {
        const entries = [
            partitionEntry({ partition: 'backlogged', totalGpus: 8, allocatedGpus: 1, pendingJobs: 5, idleGpus: 7 }),
            partitionEntry({ partition: 'quiet', totalGpus: 8, allocatedGpus: 1, pendingJobs: 0, idleGpus: 7 }),
        ];

        assert.deepEqual(sortPartitionUsageEntries(entries).map(entry => entry.partition), [
            'quiet',
            'backlogged',
        ]);
    });

    it('formats GPU partition rows and tooltip markdown', () => {
        const entry = partitionEntry({ partition: 'h200', isDefault: true });

        assert.equal(getPartitionUsageLabel(entry, 1), '1. h200 (default)');
        assert.equal(formatPartitionUsageDescription(entry), '1/16 GPUs · 15 idle · 1R/0PD');
        assert.equal(formatPartitionUsageTooltipMarkdown(entry), [
            '**h200**',
            '',
            '1/16 GPUs · 15 idle · 1R/0PD',
            '',
            '- **Default partition:** Yes',
            '- **Load:** 6%',
            '- **GPUs:** 1 allocated, 15 idle, 16 available, 16 total',
            '- **GPU types:** h200: 16 GPUs',
            '- **Running jobs:** 1',
            '- **Pending jobs:** 0',
            '- **Nodes:** 1 allocated, 3 idle, 0 other, 4 total',
        ].join('\n'));
    });

    it('formats mixed partition summaries using GPU allocation totals', () => {
        assert.equal(formatPartitionUsageSummary([
            partitionEntry({ partition: 'a', totalGpus: 8, allocatedGpus: 2, pendingJobs: 1 }),
            partitionEntry({ partition: 'b', totalGpus: 4, allocatedGpus: 1, pendingJobs: 2 }),
        ]), '3/12 GPUs allocated · 3 pending · 2 partitions');
    });
});
