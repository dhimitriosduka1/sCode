import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeferredSave } from '../deferredSave';
import { JobPathCache } from '../jobPathCache';
import { SubmitScriptCache } from '../submitScriptCache';

/** An ExtensionContext stand-in whose globalState counts writes. */
function fakeContext(storageDir = os.tmpdir()) {
    const store = new Map<string, unknown>();
    const counter = { writes: 0 };
    const context = {
        globalState: {
            get: <T>(key: string, fallback: T) => (store.has(key) ? store.get(key) as T : fallback),
            update: async (key: string, value: unknown) => {
                counter.writes++;
                store.set(key, JSON.parse(JSON.stringify(value)));
            },
        },
        globalStorageUri: { fsPath: storageDir },
    };
    return { context: context as any, counter, store };
}

describe('DeferredSave', () => {
    it('turns many changes into one write and writes nothing when nothing changed', async () => {
        let saves = 0;
        const deferred = new DeferredSave(async () => { saves++; }, 60_000);
        await deferred.flush();
        assert.equal(saves, 0);
        deferred.schedule();
        deferred.schedule();
        deferred.schedule();
        assert.equal(deferred.pending, true);
        await deferred.flush();
        assert.equal(saves, 1);
        assert.equal(deferred.pending, false);
    });

    // deactivate() flushes, and must not return while the timer's write is still landing
    it('waits for a write already under way', async () => {
        let finished = false;
        const deferred = new DeferredSave(
            () => new Promise<void>((resolve) => setTimeout(() => { finished = true; resolve(); }, 50)),
            1,
        );
        deferred.schedule();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await deferred.flush();
        assert.equal(finished, true);
    });

    it('does not report an earlier failed write again', async () => {
        let fail = true;
        const deferred = new DeferredSave(async () => {
            if (fail) {
                throw new Error('disk full');
            }
        }, 1);
        const originalConsoleError = console.error;
        console.error = () => undefined;
        try {
            deferred.schedule();
            await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
            console.error = originalConsoleError;
        }
        fail = false;
        await deferred.flush();
    });
});

describe('JobPathCache writes', () => {
    it('writes once per refresh, and not at all when the paths did not change', async () => {
        const { context, counter, store } = fakeContext();
        const cache = new JobPathCache(context);

        for (let task = 0; task < 193; task++) {
            await cache.set(`10582386_${task}`, '/logs/a.out', '/logs/a.err');
            await cache.set('10582386', '/logs/a.out', '/logs/a.err');
        }
        await cache.flush();
        assert.equal(counter.writes, 1);
        assert.equal(Object.keys(store.get('slurmJobPathCache') as object).length, 194);

        for (let task = 0; task < 193; task++) {
            await cache.set(`10582386_${task}`, '/logs/a.out', '/logs/a.err');
        }
        await cache.flush();
        assert.equal(counter.writes, 1);

        await cache.set('10582386_0', '/logs/b.out', '/logs/a.err');
        await cache.flush();
        assert.equal(counter.writes, 2);
        assert.equal(cache.get('10582386_0')?.stdoutPath, '/logs/b.out');
    });
});

describe('SubmitScriptCache array tasks', () => {
    it('copies an array job script once and serves it to every task', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurm-script-cache-'));
        try {
            const script = path.join(dir, 'job.sh');
            fs.writeFileSync(script, '#!/bin/bash\n#SBATCH -p cpu.q\n');
            const { context, counter } = fakeContext(dir);
            const cache = new SubmitScriptCache(context);

            const first = await cache.cacheScript('123_4', script);
            const second = await cache.cacheScript('123_5', script);
            const pending = await cache.cacheScript('123_[6-9%2]', script);

            assert.ok(first);
            assert.equal(second, first);
            assert.equal(pending, first);
            assert.equal(cache.has('123_7'), true);
            assert.equal(cache.has('124_7'), false);
            assert.equal(fs.readdirSync(path.join(dir, 'submit-scripts')).length, 1);

            await cache.flush();
            assert.equal(counter.writes, 1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('SubmitScriptCache copies on other machines', () => {
    it('offers no copy that is not on this machine, and leaves that machine its entry', async () => {
        // The entries are shared by every machine the extension runs on: job 123 on
        // another cluster has its copy in that machine's folder
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurm-script-cache-'));
        try {
            const script = path.join(dir, 'job.sh');
            fs.writeFileSync(script, '#!/bin/bash\n');
            const { context, store } = fakeContext(dir);
            const cachedAt = Date.now();
            const theirs = { originalPath: '/other/job.sh', cachedPath: `/other-machine/submit-scripts/123_${cachedAt}.sh`, cachedAt };
            store.set('slurmSubmitScriptCache', { '123': theirs });
            const cache = new SubmitScriptCache(context);

            assert.equal(cache.has('123'), false);
            assert.equal(cache.getCachedScriptPath('123'), undefined);

            // Copying here would take the entry over, and that machine would take it
            // back on its next refresh: a new copy on each side every refresh
            assert.equal(await cache.cacheScript('123', script), undefined);
            await cache.flush();
            assert.deepEqual(store.get('slurmSubmitScriptCache'), { '123': theirs });
            assert.deepEqual(fs.readdirSync(path.join(dir, 'submit-scripts')), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('offers no copy once its file is gone', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurm-script-cache-'));
        try {
            const script = path.join(dir, 'job.sh');
            fs.writeFileSync(script, '#!/bin/bash\n');
            const cache = new SubmitScriptCache(fakeContext(dir).context);
            const copy = await cache.cacheScript('123', script);
            assert.ok(copy);

            fs.unlinkSync(copy);

            assert.equal(cache.has('123'), false);
            assert.equal(cache.getCachedScriptPath('123'), undefined);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('SubmitScriptCache cleanup', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    it('deletes old copies in its folder even when their entries are gone', () => {
        // The index is shared by every machine the extension runs on: another one can
        // drop an entry without being able to delete the copy, which is in this folder
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurm-script-cache-'));
        try {
            const copies = path.join(dir, 'submit-scripts');
            fs.mkdirSync(copies);
            const old = `123_${Date.now() - 31 * DAY_MS}.sh`;
            const oldOnCluster = `cluster-a_124_${Date.now() - 200 * DAY_MS}.sbatch`;
            const recent = `125_${Date.now() - 29 * DAY_MS}.sh`;
            for (const name of [old, oldOnCluster, recent, 'notes.txt']) {
                fs.writeFileSync(path.join(copies, name), '#!/bin/bash\n');
            }

            new SubmitScriptCache(fakeContext(dir).context);

            assert.deepEqual(fs.readdirSync(copies).sort(), [recent, 'notes.txt'].sort());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps deleting when one old copy cannot be deleted', () => {
        // Another window or machine sharing the folder may delete a copy first
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurm-script-cache-'));
        const originalConsoleError = console.error;
        try {
            const copies = path.join(dir, 'submit-scripts');
            fs.mkdirSync(copies);
            const old = Date.now() - 31 * DAY_MS;
            // Listed first, and a folder, so deleting it fails
            fs.mkdirSync(path.join(copies, `00_${old}.sh`));
            fs.writeFileSync(path.join(copies, `123_${old}.sh`), '#!/bin/bash\n');

            console.error = () => undefined;
            new SubmitScriptCache(fakeContext(dir).context);

            assert.deepEqual(fs.readdirSync(copies), [`00_${old}.sh`]);
        } finally {
            console.error = originalConsoleError;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('drops an old entry and its copy, and keeps recent ones', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slurm-script-cache-'));
        try {
            const copies = path.join(dir, 'submit-scripts');
            fs.mkdirSync(copies);
            const entry = (jobId: string, ageDays: number, folder = copies) => {
                const cachedAt = Date.now() - ageDays * DAY_MS;
                return { originalPath: '/home/ada/job.sh', cachedPath: path.join(folder, `${jobId}_${cachedAt}.sh`), cachedAt };
            };
            const index = {
                '123': entry('123', 31),
                '125': entry('125', 29),
                // A copy on another machine, which this one cannot delete
                '126': entry('126', 31, '/other-machine/submit-scripts'),
            };
            fs.writeFileSync(index['123'].cachedPath, '#!/bin/bash\n');
            fs.writeFileSync(index['125'].cachedPath, '#!/bin/bash\n');
            const { context, store } = fakeContext(dir);
            store.set('slurmSubmitScriptCache', index);

            const cache = new SubmitScriptCache(context);
            await cache.flush();

            assert.deepEqual(Object.keys(store.get('slurmSubmitScriptCache') as object), ['125']);
            assert.equal(cache.has('125'), true);
            assert.deepEqual(fs.readdirSync(copies), [path.basename(index['125'].cachedPath)]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
