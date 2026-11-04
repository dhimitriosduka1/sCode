import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    buildStatCommand,
    buildStatManyCommand,
    buildTailCommand,
    parseRemoteStat,
    readRemoteFileTail,
    RemoteFileError,
    SshTarget,
    statRemoteFile,
    statRemoteFiles,
} from '../sshConnection';
import {
    formatByteSize,
    formatLogTruncationNotice,
    hasLogChanged,
    isLogCheckDue,
    LARGE_LOG_CHECK_EVERY,
    MAX_REMOTE_LOG_BYTES,
} from '../clusterLogs';
import { normalizeOpenableFilePath, SlurmService } from '../slurmService';

const TARGET: SshTarget = { alias: 'raven', socketPath: '/tmp/scode-ssh-501/0123456789abcdef' };

function sshFailure(code: number, stderr: string) {
    return Object.assign(new Error(`Command failed: ${stderr}`), { code, stdout: '', stderr });
}

describe('remote file commands', () => {
    it('quote the path for the cluster\'s shell and end options before it', () => {
        const stat = `stat -L -c '%s %Y %F' -- '/home/ada/it'\\''s $HOME.out'`;
        // A miss is checked again after listing the folder, which makes NFS look again
        assert.equal(buildStatCommand(`/home/ada/it's $HOME.out`), `${stat} 2>/dev/null || { ls -a -- '/home/ada' >/dev/null 2>&1; ${stat}; }`);
        assert.equal(buildTailCommand('/home/ada/-train.out', 10_485_760), `tail -c 10485760 -- '/home/ada/-train.out'`);
    });

    it('read what GNU stat reports', () => {
        assert.deepEqual(parseRemoteStat('2048 1730720000 regular file\n'), { type: 'file', size: 2048, mtimeMs: 1_730_720_000_000 });
        assert.deepEqual(parseRemoteStat('0 1730720000 regular empty file\n'), { type: 'file', size: 0, mtimeMs: 1_730_720_000_000 });
        assert.equal(parseRemoteStat('4096 1730720000 directory')?.type, 'directory');
        assert.equal(parseRemoteStat('0 1730720000 fifo')?.type, 'other');
        assert.equal(parseRemoteStat('stat: cannot stat'), undefined);
    });
});

describe('statRemoteFile', () => {
    it('stats over the master', async () => {
        const calls: string[][] = [];
        const stat = await statRemoteFile(TARGET, '/home/ada/train.out', async (_file, args) => {
            calls.push(args);
            return { stdout: '12 1730720000 regular file\n', stderr: '' };
        });

        assert.equal(stat.size, 12);
        assert.equal(calls[0][calls[0].length - 1], buildStatCommand('/home/ada/train.out'));
        assert.ok(calls[0].includes('BatchMode=yes'));
    });

    it('tells a missing file and a denied one from other failures', async () => {
        const missing = statRemoteFile(TARGET, '/home/ada/train.out', async () => {
            throw sshFailure(1, "stat: cannot statx '/home/ada/train.out': No such file or directory");
        });
        await assert.rejects(missing, (error) => error instanceof RemoteFileError && error.reason === 'missing');

        const denied = statRemoteFile(TARGET, '/home/bob/train.out', async () => {
            throw sshFailure(1, "stat: cannot statx '/home/bob/train.out': Permission denied");
        });
        await assert.rejects(denied, (error) => error instanceof RemoteFileError && error.reason === 'denied');
    });

    it('leaves ssh\'s own failures alone, so a dropped connection is not taken for a missing file', async () => {
        const failure = sshFailure(255, 'Connection closed by remote host');
        await assert.rejects(statRemoteFile(TARGET, '/home/ada/train.out', async () => {
            throw failure;
        }), (error) => error === failure);
    });
});

describe('statRemoteFiles', () => {
    it('stats every open log in one call, one line each, a dash for one that can\'t be stat\'ed', async () => {
        assert.equal(buildStatManyCommand(['/a.out', '/b.err']),
            `{ ${buildStatCommand('/a.out')}; } 2>/dev/null || echo -; { ${buildStatCommand('/b.err')}; } 2>/dev/null || echo -`);

        let calls = 0;
        const stats = await statRemoteFiles(TARGET, ['/a.out', '/gone.out', '/b.err'], async (_file, args) => {
            calls++;
            assert.equal(args[args.length - 1], buildStatManyCommand(['/a.out', '/gone.out', '/b.err']));
            return { stdout: '12 1730720000 regular file\n-\n0 1730720005 regular empty file\n', stderr: '' };
        });

        assert.equal(calls, 1);
        assert.deepEqual(stats, [
            { type: 'file', size: 12, mtimeMs: 1_730_720_000_000 },
            undefined,
            { type: 'file', size: 0, mtimeMs: 1_730_720_005_000 },
        ]);
        assert.deepEqual(await statRemoteFiles(TARGET, [], async () => assert.fail('no call for no logs')), []);
    });

    it('lets ssh\'s own failures through, so a dropped connection is noticed', async () => {
        const failure = sshFailure(255, 'Connection closed by remote host');
        await assert.rejects(statRemoteFiles(TARGET, ['/a.out'], async () => {
            throw failure;
        }), (error) => error === failure);
    });
});

describe('checking open logs', () => {
    const small = { size: 2048, mtimeMs: 1_730_720_000_000 };
    const large = { size: MAX_REMOTE_LOG_BYTES + 1, mtimeMs: 1_730_720_000_000 };

    it('re-reads a log when it grew or was rewritten, or was never read', () => {
        assert.equal(hasLogChanged(small, { ...small }), false);
        assert.equal(hasLogChanged(small, { ...small, size: 4096 }), true);
        assert.equal(hasLogChanged(small, { ...small, mtimeMs: small.mtimeMs + 1000 }), true);
        assert.equal(hasLogChanged(undefined, small), true);
    });

    it('checks logs over the cap less often, since each change re-sends 10 MB', () => {
        const rounds = Array.from({ length: LARGE_LOG_CHECK_EVERY * 2 }, (_value, round) => round);
        assert.ok(rounds.every((round) => isLogCheckDue(small, round)));
        assert.ok(rounds.every((round) => isLogCheckDue(undefined, round)));
        assert.equal(rounds.filter((round) => isLogCheckDue(large, round)).length, 2);
    });
});

describe('readRemoteFileTail', () => {
    it('returns the bytes as they are, leaving room in the buffer for growth', async () => {
        const bytes = Buffer.from([0xe2, 0x9c, 0x93, 0x0a, 0xff]);
        let maxBuffer: number | undefined;
        const content = await readRemoteFileTail(TARGET, '/home/ada/train.out', 1024, async (_file, args, options) => {
            maxBuffer = options.maxBuffer;
            assert.equal(args[args.length - 1], `tail -c 1024 -- '/home/ada/train.out'`);
            return bytes;
        });

        assert.deepEqual(content, bytes);
        assert.ok(maxBuffer !== undefined && maxBuffer > 1024);
    });
});

describe('log truncation notice', () => {
    it('says how much of how big a log is shown', () => {
        assert.equal(formatByteSize(512), '512 B');
        assert.equal(formatByteSize(1536), '1.5 KB');
        assert.equal(formatByteSize(MAX_REMOTE_LOG_BYTES), '10 MB');
        assert.equal(formatByteSize(3.4 * 1024 ** 3), '3.4 GB');
        assert.equal(formatLogTruncationNotice(3.4 * 1024 ** 3), '[Showing the last 10 MB of this 3.4 GB log.]\n\n');
    });
});

describe('paths on a cluster', () => {
    it('expand ~ to the home folder there, and leave it when that is unknown', () => {
        const remote = { username: 'kqr876', homeDir: '/home/kqr876', cluster: 'galvani' };

        assert.equal(normalizeOpenableFilePath('~/logs/train.out', undefined, remote), '/home/kqr876/logs/train.out');
        assert.equal(normalizeOpenableFilePath('~', undefined, remote), '/home/kqr876');
        assert.equal(normalizeOpenableFilePath('~/logs/train.out', undefined, { cluster: 'galvani' }), '~/logs/train.out');
    });

    it('keep cached log paths per cluster, since job IDs repeat across clusters', async () => {
        const cache = new Map<string, { stdoutPath: string; stderrPath: string; cachedAt: number }>();
        const pathCache = {
            get: (key: string) => cache.get(key),
            set: async (key: string, stdoutPath: string, stderrPath: string) => {
                cache.set(key, { stdoutPath, stderrPath, cachedAt: Date.now() });
            },
        } as any;
        let cluster = 'galvani';
        const service = new SlurmService(pathCache, undefined, async () => ({ stdout: '', stderr: '' }), () => false,
            () => ({ username: 'kqr876', homeDir: '/home/kqr876', cluster }));

        await pathCache.set('galvani:4242', '/scratch/galvani/train-%j.out', '/scratch/galvani/train-%j.err');
        await pathCache.set('raven:4242', '/ptmp/raven/eval-%j.out', '/ptmp/raven/eval-%j.err');

        assert.equal((await service.getHistoryJobPaths('4242')).stdoutPath, '/scratch/galvani/train-4242.out');
        cluster = 'raven';
        assert.equal((await service.getHistoryJobPaths('4242')).stdoutPath, '/ptmp/raven/eval-4242.out');
    });
});
