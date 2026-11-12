import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildStatCommand, checkSharedFolder, ExecFileRunner } from '../sshConnection';
import { SubmitScriptCache } from '../submitScriptCache';

const TARGET = { alias: 'raven', socketPath: '/tmp/scode-ssh-501/0123456789abcdef' };

function withFolder(test: (folder: string) => Promise<void>) {
    return async () => {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-shared-'));
        try {
            await test(folder);
        } finally {
            fs.rmSync(folder, { recursive: true, force: true });
        }
    };
}

/** The probe path in the command the check sends to the cluster. */
function probeIn(args: string[]): string {
    return args[args.length - 1].match(/^stat -L -c '[^']+' -- '([^']+)'/)![1];
}

/** A cluster that sees this computer's files, as with a shared file system. */
const sharing: ExecFileRunner = async (_file, args) => {
    const probe = probeIn(args);
    assert.equal(args[args.length - 1], buildStatCommand(probe));
    const stat = fs.statSync(probe);
    return { stdout: `${stat.size} ${Math.floor(stat.mtimeMs / 1000)} regular empty file\n`, stderr: '' };
};

describe('checking the file system is shared', () => {
    it('is shared when a file written here shows up there, and leaves nothing behind', withFolder(async (folder) => {
        let probe = '';
        const result = await checkSharedFolder(TARGET, folder, async (file, args, options) => {
            probe = probeIn(args);
            assert.ok(path.dirname(probe) === folder && path.basename(probe).startsWith('.scode-shared-check-'));
            return sharing(file, args, options);
        });

        assert.deepEqual(result, { shared: true });
        assert.equal(fs.existsSync(probe), false);
        assert.deepEqual(fs.readdirSync(folder), []);
    }));

    it('is not shared when the folder is not on this computer', async () => {
        let called = false;
        const result = await checkSharedFolder(TARGET, '/home/nobody-here-4242', async () => {
            called = true;
            return { stdout: '', stderr: '' };
        });

        assert.deepEqual(result, { shared: false, reason: '/home/nobody-here-4242 does not exist on this computer' });
        assert.equal(called, false);
    });

    it('is not shared when the cluster does not see the file', withFolder(async (folder) => {
        const missing = await checkSharedFolder(TARGET, folder, async () => {
            throw Object.assign(new Error('failed'), { code: 1, stderr: "stat: cannot statx 'x': No such file or directory" });
        });
        assert.deepEqual(missing, { shared: false, reason: `a file written to ${folder} here does not show up there` });

        const dropped = await checkSharedFolder(TARGET, folder, async () => {
            throw Object.assign(new Error('Connection closed'), { code: 255, stderr: 'Connection closed' });
        });
        assert.equal(dropped.shared, false);
        assert.deepEqual(fs.readdirSync(folder), []);
    }));
});

describe('submit script cache on a cluster', () => {
    it('keeps copies per cluster, since job IDs repeat across clusters', withFolder(async (folder) => {
        const state = new Map<string, unknown>();
        const cache = new SubmitScriptCache({
            globalStorageUri: { fsPath: path.join(folder, 'storage') },
            globalState: {
                get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
                update: async (key: string, value: unknown) => {
                    state.set(key, value);
                },
            },
        } as any);
        const train = path.join(folder, 'train.sbatch');
        const evaluate = path.join(folder, 'eval.sbatch');
        fs.writeFileSync(train, '#SBATCH -p gpu\n');
        fs.writeFileSync(evaluate, '#SBATCH -p cpu\n');

        await cache.cacheScript('4242', train, 'galvani');
        await cache.cacheScript('4242', evaluate, 'raven');

        assert.equal(cache.getOriginalScriptPath('4242', 'galvani'), train);
        assert.equal(fs.readFileSync(cache.getCachedScriptPath('4242', 'raven')!, 'utf8'), '#SBATCH -p cpu\n');
        // A job with the same ID on this machine is a different job
        assert.equal(cache.has('4242'), false);
    }));
});
