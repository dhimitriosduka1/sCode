import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SlurmCommandRunner, SlurmService } from '../slurmService';

describe('SlurmService job history', () => {
    it('fetches allocation rows with a larger buffer and parses completed history', async () => {
        const commands: string[] = [];
        const optionsSeen: unknown[] = [];
        const commandRunner: SlurmCommandRunner = async (command, options) => {
            commands.push(command);
            optionsSeen.push(options);
            return {
                stdout: [
                    '123|complete_job|COMPLETED|0:0|2026-05-22T10:00:00|2026-05-22T10:05:00|00:05:00|a100|node-a|4|',
                    '123.batch|batch|COMPLETED|0:0|2026-05-22T10:00:00|2026-05-22T10:05:00|00:05:00||node-a|4|1024K',
                    '124|running_job|RUNNING|0:0|2026-05-22T10:00:00|Unknown|00:00:30|a100|node-b|4|',
                    '125|pending_job|PENDING|0:0|Unknown|Unknown|00:00:00|a100||4|',
                    '126|failed_job|FAILED|1:0|2026-05-22T10:00:00|2026-05-22T10:06:00|00:06:00|a100|node-c|4|',
                ].join('\n'),
                stderr: '',
            };
        };
        const service = new SlurmService(undefined, undefined, commandRunner);

        const jobs = await service.getJobHistory(3);

        assert.equal(commands.length, 1);
        assert.match(commands[0], /^sacct -X -u \$USER --starttime=\d{4}-\d{2}-\d{2}/);
        assert.match(commands[0], /--parsable2/);
        assert.match(commands[0], /--format=JobID,JobName,State,ExitCode,Start,End,Elapsed,Partition,NodeList,AllocCPUS,MaxRSS/);
        assert.equal((optionsSeen[0] as { maxBuffer?: number }).maxBuffer, 16 * 1024 * 1024);
        assert.deepEqual(jobs.map(job => job.jobId), ['126', '123']);
        assert.deepEqual(jobs.map(job => job.state), ['FAILED', 'COMPLETED']);
    });

    it('requests and parses TotalCPU and AllocTRES for efficiency reporting', async () => {
        const commandRunner: SlurmCommandRunner = async (command) => ({
            stdout: '123|train|COMPLETED|0:0|2026-05-22T10:00:00|2026-05-22T11:00:00|01:00:00|a100|node-a|8|16G|04:00:00|billing=8,cpu=8,mem=32G,node=1',
            stderr: '',
        });
        const service = new SlurmService(undefined, undefined, commandRunner);

        const jobs = await service.getJobHistory(3);

        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].totalCpuTime, '04:00:00');
        assert.equal(jobs[0].allocMemory, '32G');
    });

    it('defaults efficiency fields to N/A when TotalCPU/AllocTRES columns are missing', async () => {
        const commandRunner: SlurmCommandRunner = async () => ({
            stdout: '123|train|COMPLETED|0:0|2026-05-22T10:00:00|2026-05-22T11:00:00|01:00:00|a100|node-a|8|16G',
            stderr: '',
        });
        const service = new SlurmService(undefined, undefined, commandRunner);

        const jobs = await service.getJobHistory(3);

        assert.equal(jobs[0].totalCpuTime, 'N/A');
        assert.equal(jobs[0].allocMemory, 'N/A');
    });

    it('resolves history paths from cache, including base ID fallback for arrays', async () => {
        const mockCacheMap = new Map<string, any>();
        const mockPathCache = {
            get: (key: string) => mockCacheMap.get(key),
            set: async (key: string, stdoutPath: string, stderrPath: string) => {
                mockCacheMap.set(key, { stdoutPath, stderrPath, cachedAt: Date.now() });
            },
        } as any;

        const service = new SlurmService(mockPathCache, undefined, async () => ({ stdout: '', stderr: '' }));

        // Pre-populate cache with a raw path for master ID 9999
        await mockPathCache.set('9999', 'logs/%A_%a.out', 'logs/%A_%a.err');

        // Verify lookup of specific task ID 9999_3 hits the fallback to 9999 and expands placeholders
        const paths = await service.getHistoryJobPaths('9999_3', { jobName: 'array-test', nodes: 'node01' });

        assert.equal(paths.stdoutPath, 'logs/9999_3.out');
        assert.equal(paths.stderrPath, 'logs/9999_3.err');
    });
});
