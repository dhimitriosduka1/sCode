import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert/strict';
import { AutoRefreshScheduler } from '../autoRefreshScheduler';

const INTERVAL = 30_000;

describe('AutoRefreshScheduler', () => {
    beforeEach(() => {
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
    });

    afterEach(() => {
        mock.timers.reset();
    });

    it('does not fire before the first full interval elapses', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        mock.timers.tick(INTERVAL - 1);
        assert.equal(refreshes, 0);

        mock.timers.tick(1);
        assert.equal(refreshes, 1);
    });

    it('fires on a steady cadence while focused', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        // Ticked one period at a time: the repeating timer is created inside the
        // first timer's callback, so a single lump tick would not advance it
        mock.timers.tick(INTERVAL);
        assert.equal(refreshes, 1);
        mock.timers.tick(INTERVAL);
        assert.equal(refreshes, 2);
        mock.timers.tick(INTERVAL);
        assert.equal(refreshes, 3);
    });

    it('does not fire at all while the window is unfocused', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        scheduler.setFocused(false);
        mock.timers.tick(INTERVAL * 10);

        assert.equal(refreshes, 0);
        assert.equal(scheduler.isScheduled(), false);
    });

    it('refreshes exactly once when focus returns after a long absence', () => {
        // This is the reported bug: minimizing for several intervals used to queue up
        // a refresh per tick, and they all landed at once on refocus.
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        scheduler.setFocused(false);
        mock.timers.tick(INTERVAL * 10);
        scheduler.setFocused(true);

        // The period is long overdue, so the catch-up refresh runs on the next tick
        mock.timers.tick(0);
        assert.equal(refreshes, 1);
    });

    it('resumes the steady cadence after a catch-up refresh', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        scheduler.setFocused(false);
        mock.timers.tick(INTERVAL * 10);
        scheduler.setFocused(true);
        mock.timers.tick(0);
        assert.equal(refreshes, 1);

        mock.timers.tick(INTERVAL * 2);
        assert.equal(refreshes, 3);
    });

    it('does not add a refresh when briefly tabbing away and back', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        mock.timers.tick(10_000);
        scheduler.setFocused(false);
        mock.timers.tick(1_000);
        scheduler.setFocused(true);

        // Focus alone must not trigger a refresh - the period has not elapsed
        assert.equal(refreshes, 0);

        // It fires on the remainder of the original period, not a fresh full one
        mock.timers.tick(INTERVAL - 11_000 - 1);
        assert.equal(refreshes, 0);
        mock.timers.tick(1);
        assert.equal(refreshes, 1);
    });

    it('stays quiet across repeated focus toggles', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        for (let i = 0; i < 20; i++) {
            scheduler.setFocused(false);
            mock.timers.tick(100);
            scheduler.setFocused(true);
            mock.timers.tick(100);
        }

        // 4s of simulated time across 20 toggles is still well inside one period
        assert.equal(refreshes, 0);
    });

    it('never double-arms when focus is reported redundantly', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        scheduler.setFocused(true);
        scheduler.setFocused(true);
        mock.timers.tick(INTERVAL);

        assert.equal(refreshes, 1);
    });

    it('does not schedule anything when started while unfocused', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(false);
        scheduler.start(INTERVAL, () => refreshes++);

        assert.equal(scheduler.isScheduled(), false);
        mock.timers.tick(INTERVAL * 5);
        assert.equal(refreshes, 0);

        scheduler.setFocused(true);
        mock.timers.tick(0);
        assert.equal(refreshes, 1);
    });

    it('stops firing after stop()', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        mock.timers.tick(INTERVAL);
        assert.equal(refreshes, 1);

        scheduler.stop();
        mock.timers.tick(INTERVAL * 5);
        assert.equal(refreshes, 1);
        assert.equal(scheduler.isScheduled(), false);
    });

    it('stop() cancels a pending catch-up refresh', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);

        scheduler.setFocused(false);
        mock.timers.tick(INTERVAL * 3);
        scheduler.setFocused(true);
        scheduler.stop();

        mock.timers.tick(INTERVAL * 5);
        assert.equal(refreshes, 0);
    });

    it('start() replaces a previous schedule instead of stacking', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(INTERVAL, () => refreshes++);
        mock.timers.tick(INTERVAL / 2);

        // Simulates the user changing the interval setting
        scheduler.start(INTERVAL, () => refreshes++);
        mock.timers.tick(INTERVAL);

        assert.equal(refreshes, 1);
    });

    it('ignores a non-positive interval', () => {
        let refreshes = 0;
        const scheduler = new AutoRefreshScheduler(true);
        scheduler.start(0, () => refreshes++);

        assert.equal(scheduler.isScheduled(), false);
        mock.timers.tick(INTERVAL * 5);
        assert.equal(refreshes, 0);
    });
});
