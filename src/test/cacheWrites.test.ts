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
