import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { PartitionDataSource, PartitionDataStore } from '../partitionDataStore';
import { CpuPartitionUsage, PartitionUsageResult } from '../slurmService';

const cpu = (partition: string, allocatedCpus: number): CpuPartitionUsage =>
    ({ partition, allocatedCpus, idleCpus: 100 - allocatedCpus, otherCpus: 0, totalCpus: 100 });
const noGpus: PartitionUsageResult = { entries: [], clusterAllocatedGpus: 0, clusterAvailableGpus: 0 };

/** A fake Slurm whose answers the test controls; counts how often it is queried */
function fakeSource(answers: { cpu: CpuPartitionUsage[]; available?: boolean }) {
    const source = {
        queries: 0,
        answers,
        async isAvailable() { return answers.available ?? true; },
        async getPartitionUsage() { source.queries++; await new Promise(resolve => setImmediate(resolve)); return noGpus; },
        async getCpuPartitionUsage() { return answers.cpu; },
    } satisfies PartitionDataSource & { queries: number; answers: unknown };
    return source;
}

describe('PartitionDataStore', () => {
    it('has no snapshot until the first refresh', () => {
        const store = new PartitionDataStore(fakeSource({ cpu: [cpu('a', 10)] }));
        assert.equal(store.snapshot, undefined);
    });

    it('builds a ranked snapshot on refresh', async () => {
        const store = new PartitionDataStore(fakeSource({ cpu: [cpu('busy', 90), cpu('quiet', 10)] }));

        const snapshot = await store.refresh();

        assert.deepEqual(snapshot.loads.map(load => load.partition), ['quiet', 'busy']);
        assert.equal(store.snapshot, snapshot);
    });

    it('shares one set of queries between concurrent refreshes', async () => {
        const source = fakeSource({ cpu: [cpu('a', 10)] });
        const store = new PartitionDataStore(source);

        const [first, second] = await Promise.all([store.refresh(), store.refresh()]);

        assert.equal(source.queries, 1);
        assert.equal(first, second);
    });

    it('fetches once for the first getSnapshot, then serves the cached snapshot', async () => {
        const source = fakeSource({ cpu: [cpu('a', 10)] });
        const store = new PartitionDataStore(source);

        await store.getSnapshot();
        await store.getSnapshot();

        assert.equal(source.queries, 1);
    });

    it('replaces the snapshot on every refresh, scheduled or manual', async () => {
        const source = fakeSource({ cpu: [cpu('a', 10)] });
        const store = new PartitionDataStore(source);
        await store.refresh();

        source.answers.cpu = [cpu('a', 80)];
        await store.refresh();

        assert.equal(store.snapshot?.loads[0].loadRatio, 0.8);
    });

    it('notifies listeners when the snapshot is replaced', async () => {
        const store = new PartitionDataStore(fakeSource({ cpu: [cpu('a', 10)] }));
        let notifications = 0;
        const unsubscribe = store.onDidChange(() => notifications++);

        await store.refresh();
        unsubscribe();
        await store.refresh();

        assert.equal(notifications, 1);
    });

    it('keeps the last good snapshot when a refresh comes back empty', async () => {
        const source = fakeSource({ cpu: [cpu('a', 10)] });
        const store = new PartitionDataStore(source);
        const good = await store.refresh();
        let notifications = 0;
        store.onDidChange(() => notifications++);

        source.answers.cpu = [];
        const result = await store.refresh();

        assert.equal(result, good);
        assert.equal(store.snapshot, good);
        assert.equal(notifications, 0);
    });

    it('stores an empty snapshot without querying when Slurm is unavailable', async () => {
        const source = fakeSource({ cpu: [cpu('a', 10)], available: false });
        const store = new PartitionDataStore(source);

        const snapshot = await store.refresh();

        assert.deepEqual(snapshot.loads, []);
        assert.equal(source.queries, 0);
    });

    it('accepts empty data after clear, e.g. when mock mode is turned off', async () => {
        const source = fakeSource({ cpu: [cpu('a', 10)] });
        const store = new PartitionDataStore(source);
        await store.refresh();

        store.clear();
        source.answers.available = false;
        await store.refresh();

        assert.deepEqual(store.snapshot?.loads, []);
    });
});
