import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SlurmService } from '../slurmService';
import { CachedSubmitScript } from '../submitScriptCache';

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-resubmit-'));
    tempDirs.push(dir);
    return dir;
}

function writeScript(dir: string, name: string, contents: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
}

/**
 * Minimal stand-in for SubmitScriptCache; getResubmitCandidate only reads entries.
 */
function fakeScriptCache(entries: Record<string, CachedSubmitScript>): any {
    return { get: (jobId: string) => entries[jobId] };
}

function makeService(scriptCache: any): SlurmService {
    return new SlurmService(undefined, scriptCache, async () => ({ stdout: '', stderr: '' }));
}

afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
});

describe('SlurmService.getResubmitCandidate', () => {
    it('returns both copies and reports an unchanged script', async () => {
        const dir = makeTempDir();
        const original = writeScript(dir, 'train.sbatch', '#SBATCH --time=1:00:00\n');
        const snapshot = writeScript(dir, 'snapshot.sbatch', '#SBATCH --time=1:00:00\n');
        const service = makeService(fakeScriptCache({
            '12345': { originalPath: original, cachedPath: snapshot, cachedAt: Date.now() },
        }));

        const candidate = await service.getResubmitCandidate('12345', '/work/lab');

        assert.deepEqual(candidate, {
            snapshotPath: snapshot,
            currentPath: original,
            workDir: '/work/lab',
            changed: false,
        });
    });

    it('flags a script that was edited after submission', async () => {
        const dir = makeTempDir();
        const original = writeScript(dir, 'train.sbatch', '#SBATCH --time=8:00:00\n');
        const snapshot = writeScript(dir, 'snapshot.sbatch', '#SBATCH --time=1:00:00\n');
        const service = makeService(fakeScriptCache({
            '12345': { originalPath: original, cachedPath: snapshot, cachedAt: Date.now() },
        }));

        const candidate = await service.getResubmitCandidate('12345', '/work/lab');

        assert.equal(candidate.changed, true);
    });

    it('finds the array job entry when resubmitting a single array task', async () => {
        const dir = makeTempDir();
        const original = writeScript(dir, 'sweep.sbatch', '#SBATCH --array=0-9\n');
        const snapshot = writeScript(dir, 'snapshot.sbatch', '#SBATCH --array=0-9\n');
        const service = makeService(fakeScriptCache({
            '12345': { originalPath: original, cachedPath: snapshot, cachedAt: Date.now() },
        }));

        const candidate = await service.getResubmitCandidate('12345_7', '/work/lab');

        assert.equal(candidate.snapshotPath, snapshot);
        assert.equal(candidate.currentPath, original);
    });

    it('ignores a cache entry whose snapshot file has been deleted', async () => {
        const dir = makeTempDir();
        const original = writeScript(dir, 'train.sbatch', '#SBATCH --time=1:00:00\n');
        const service = makeService(fakeScriptCache({
            '12345': {
                originalPath: original,
                cachedPath: path.join(dir, 'gone.sbatch'),
                cachedAt: Date.now(),
            },
        }));

        const candidate = await service.getResubmitCandidate('12345', '/work/lab');

        assert.equal(candidate.snapshotPath, undefined);
        assert.equal(candidate.currentPath, original);
        assert.equal(candidate.changed, undefined);
    });

    it('still offers the snapshot when the original script has been deleted', async () => {
        const dir = makeTempDir();
        const snapshot = writeScript(dir, 'snapshot.sbatch', '#SBATCH --time=1:00:00\n');
        const service = makeService(fakeScriptCache({
            '12345': {
                originalPath: path.join(dir, 'deleted.sbatch'),
                cachedPath: snapshot,
                cachedAt: Date.now(),
            },
        }));

        const candidate = await service.getResubmitCandidate('12345', '/work/lab');

        assert.equal(candidate.snapshotPath, snapshot);
        assert.equal(candidate.currentPath, undefined);
    });

    it('reports the mock history job script when mock mode is on', async () => {
        const service = new SlurmService(
            undefined,
            undefined,
            async () => ({ stdout: '', stderr: '' }),
            () => true
        );

        const history = await service.getJobHistory();
        const candidate = await service.getResubmitCandidate(history[0].jobId);

        assert.equal(candidate.currentPath, '/work/vision_lab/slurm/finished-training.sbatch');
        assert.equal(candidate.workDir, '/work/vision_lab/runs/finished-training');
    });

    it('offers nothing for an unknown job in mock mode', async () => {
        const service = new SlurmService(
            undefined,
            undefined,
            async () => ({ stdout: '', stderr: '' }),
            () => true
        );

        assert.deepEqual(await service.getResubmitCandidate('404404'), {});
    });

    it('reports the mock job script when mock mode is on', async () => {
        const service = new SlurmService(
            undefined,
            undefined,
            async () => ({ stdout: '', stderr: '' }),
            () => true
        );

        const jobs = await service.getJobs();
        const candidate = await service.getResubmitCandidate(jobs[0].jobId);

        assert.equal(candidate.currentPath, jobs[0].submitScript);
        assert.equal(candidate.workDir, jobs[0].workDir);
    });
});
