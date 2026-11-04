import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { RefreshGate } from '../refreshGate';

/** A load that finishes when the test says so. */
function controlledLoad(): { promise: Promise<string>; finish: (value: string) => void } {
    let finish!: (value: string) => void;
    const promise = new Promise<string>((resolve) => { finish = resolve; });
    return { promise, finish };
}

describe('RefreshGate', () => {
    it('reloads straight away when nothing is loading', () => {
        let reloads = 0;
        const gate = new RefreshGate<string>(() => reloads++);

        gate.refresh();

        assert.equal(reloads, 1);
    });

    it('holds refreshes asked for during a load, and reloads once after it however many there were', async () => {
        let reloads = 0;
        const gate = new RefreshGate<string>(() => reloads++);
        const first = controlledLoad();

        const shown = gate.load(() => first.promise);
        gate.refresh();
        gate.refresh();
        gate.refresh();
        assert.equal(reloads, 0, 'no reload while the load runs');

        first.finish('jobs');
        assert.equal(await shown, 'jobs', 'the load in progress still shows its result');
        assert.equal(reloads, 1);
    });

    it('does not reload after a load nobody refreshed during', async () => {
        let reloads = 0;
        const gate = new RefreshGate<string>(() => reloads++);

        await gate.load(async () => 'jobs');

        assert.equal(reloads, 0);
    });

    it('shares the load in progress with every caller', async () => {
        const gate = new RefreshGate<string>(() => undefined);
        const first = controlledLoad();
        let loads = 0;

        const a = gate.load(() => { loads++; return first.promise; });
        const b = gate.load(() => { loads++; return Promise.resolve('second'); });
        first.finish('first');

        assert.deepEqual(await Promise.all([a, b]), ['first', 'first']);
        assert.equal(loads, 1);
        assert.equal(await gate.load(async () => 'next'), 'next', 'a load after it runs afresh');
    });

    it('reports refreshing from the start of a load that fetches until the last one is done', async () => {
        const changes: boolean[] = [];
        let reloads = 0;
        const gate = new RefreshGate<string>(() => reloads++, (refreshing) => changes.push(refreshing));

        // The first load fetches: the view has no data yet
        await gate.load(async () => 'jobs');
        assert.deepEqual(changes, [true, false]);

        // One asked for during a load keeps it refreshing through the load that follows
        changes.length = 0;
        gate.refresh();
        const first = controlledLoad();
        const shown = gate.load(() => first.promise);
        gate.refresh();
        first.finish('jobs');
        await shown;
        assert.deepEqual(changes, [true], 'not done while the follow-up load is still to come');
        assert.equal(reloads, 2);

        await gate.load(async () => 'newer jobs');
        assert.equal(changes[changes.length - 1], false);
    });

    it('does not report refreshing for a load that only redraws, e.g. after a search', async () => {
        const changes: boolean[] = [];
        const gate = new RefreshGate<string>(() => undefined, (refreshing) => changes.push(refreshing));
        await gate.load(async () => 'jobs');
        changes.length = 0;

        await gate.load(async () => 'jobs matching the search');

        assert.deepEqual(changes, []);
    });

    it('reloads after a load that failed, too', async () => {
        let reloads = 0;
        const gate = new RefreshGate<string>(() => reloads++);

        const failed = gate.load(() => Promise.reject(new Error('squeue failed')));
        gate.refresh();

        await assert.rejects(failed);
        assert.equal(reloads, 1);
    });
});
