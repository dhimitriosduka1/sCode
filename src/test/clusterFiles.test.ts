import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    ClusterFileError,
    expandClusterHome,
    mapToClusterFolder,
    readClusterFile,
    resolveClusterPath,
    validateClusterFolder,
} from '../clusterFiles';
import { SlurmNotConnectedError } from '../slurmCommandRunner';

describe('resolveClusterPath', () => {
    it('keeps absolute paths, tidied', () => {
        assert.equal(resolveClusterPath('/work/alice//logs/../logs/1.out', undefined), '/work/alice/logs/1.out');
    });

    it('expands ~ to the home directory on the cluster', () => {
        assert.equal(resolveClusterPath('~/logs/1.out', '/home/alice'), '/home/alice/logs/1.out');
        assert.equal(resolveClusterPath('~', '/home/alice'), '/home/alice');
    });

    it('refuses what it cannot place on the cluster', () => {
        const problem = (filePath: string, home?: string) => {
            try {
                resolveClusterPath(filePath, home);
                return undefined;
            } catch (error) {
                return error instanceof ClusterFileError ? error.problem : 'other';
            }
        };

        assert.equal(problem('N/A'), 'unresolved');
        assert.equal(problem('logs/1.out'), 'unresolved');
        assert.equal(problem('~/logs/1.out'), 'unresolved');
        assert.equal(problem('/work/alice/logs/%j.out'), 'unresolved');
        assert.equal(problem('/work/alice/logs/PENDING_NODE.out'), 'unresolved');
    });
});

describe('expandClusterHome', () => {
    it('leaves other paths alone', () => {
        assert.equal(expandClusterHome('/work/x', undefined), '/work/x');
        assert.equal(expandClusterHome('~other/x', '/home/alice'), '~other/x');
    });
});

describe('validateClusterFolder', () => {
    it('accepts absolute paths and paths in the home directory', () => {
        for (const folder of ['/work/alice/project', '~', '~/project']) {
            assert.equal(validateClusterFolder(folder), undefined, folder);
        }
    });

    it('refuses relative paths, empty input, and line breaks', () => {
        for (const folder of ['', 'project', './project', '~other/project', '/work/a\nb']) {
            assert.ok(validateClusterFolder(folder), JSON.stringify(folder));
        }
    });
});

describe('mapToClusterFolder', () => {
    it('mirrors the script\'s folder under the workspace\'s copy', () => {
        assert.equal(
            mapToClusterFolder('/work/alice/project', undefined, '/home/me/project', '/home/me/project/jobs/gpu/train.sbatch'),
            '/work/alice/project/jobs/gpu',
        );
    });

    it('submits a script at the workspace root from the copy\'s root', () => {
        assert.equal(mapToClusterFolder('~/project', '/home/alice', '/home/me/project', '/home/me/project/train.sbatch'), '/home/alice/project');
    });

    it('submits scripts outside the workspace from the copy\'s root', () => {
        assert.equal(mapToClusterFolder('/work/p', undefined, '/home/me/project', '/tmp/train.sbatch'), '/work/p');
        assert.equal(mapToClusterFolder('/work/p', undefined, undefined, '/tmp/train.sbatch'), '/work/p');
    });

    it('needs the home directory for a folder starting with ~', () => {
        assert.equal(mapToClusterFolder('~/project', undefined, '/home/me/project', '/home/me/project/train.sbatch'), undefined);
    });
});

describe('readClusterFile', () => {
    it('reads the end of the file with tail, one byte past the limit', async () => {
        const calls: (readonly string[])[] = [];
        const content = await readClusterFile(async argv => {
            calls.push(argv);
            return { stdout: 'epoch 1\nepoch 2\n', stderr: '' };
        }, '/work/alice/logs/1.out', 100);

        assert.deepEqual(calls, [['tail', '-c', '101', '--', '/work/alice/logs/1.out']]);
        assert.deepEqual(content, { text: 'epoch 1\nepoch 2\n', truncated: false });
    });

    it('starts a truncated file at a whole line', async () => {
        const content = await readClusterFile(async () => ({ stdout: 'ch 1\nepoch 2\nepoch 3\n', stderr: '' }), '/x', 16);

        assert.deepEqual(content, { text: 'epoch 2\nepoch 3\n', truncated: true });
    });

    it('tells a missing file, a directory, and an unreadable file apart', async () => {
        const failWith = (stderr: string) => readClusterFile(async argv => {
            throw new Error(`Command failed: ${argv.join(' ')}\n${stderr}`);
        }, '/work/x');
        const problemOf = (promise: Promise<unknown>) => promise.then(
            () => undefined,
            error => error instanceof ClusterFileError ? error.problem : 'other',
        );

        assert.equal(await problemOf(failWith('tail: cannot open \'/work/x\' for reading: No such file or directory')), 'not-found');
        assert.equal(await problemOf(failWith('tail: error reading \'/work/x\': Is a directory')), 'directory');
        assert.equal(await problemOf(failWith('tail: cannot open \'/work/x\' for reading: Permission denied')), 'unreadable');
    });

    it('lets a lost connection through for the caller to handle', async () => {
        await assert.rejects(
            readClusterFile(async () => { throw new SlurmNotConnectedError('mycluster'); }, '/x'),
            SlurmNotConnectedError,
        );
    });
});
