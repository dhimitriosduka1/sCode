import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeUnavailable } from '../slurmAvailability';
import { SlurmNotConnectedError } from '../slurmCommandRunner';
import { localCommandRunner } from '../slurmCommandRunner';
import { SlurmCommandRunner, SlurmService, splitMarkedJobOutput } from '../slurmService';

function createService(runner: SlurmCommandRunner, scriptCache?: unknown): SlurmService {
    return new SlurmService(undefined, scriptCache as never, runner, () => false);
}

describe('SlurmService availability', () => {
    it('remembers that Slurm is missing on this machine', async () => {
        let probes = 0;
        const service = createService(async () => {
            probes++;
            throw new Error('spawn squeue ENOENT');
        });

        assert.deepEqual(await service.getAvailability(), { available: false, reason: 'missing', host: undefined });
        await service.getAvailability();
        assert.equal(probes, 1);
    });

    it('asks again while not connected, as the connection can come back', async () => {
        let connected = false;
        const service = createService(async () => {
            if (!connected) {
                throw new SlurmNotConnectedError('mycluster');
            }
            return { stdout: 'slurm 23.11.4\n', stderr: '' };
        });
        service.resetSession('mycluster');

        assert.deepEqual(await service.getAvailability(), { available: false, reason: 'disconnected', host: 'mycluster' });
        connected = true;
        assert.deepEqual(await service.getAvailability(), { available: true });
    });

    it('names the host when Slurm is missing there', async () => {
        const service = createService(async () => {
            throw new Error('bash: squeue: command not found');
        });
        service.resetSession('mycluster');

        assert.deepEqual(await service.getAvailability(), { available: false, reason: 'missing', host: 'mycluster' });
    });

    it('notices a dropped connection on the next render', async () => {
        let connected = true;
        const service = createService(async argv => {
            if (!connected) {
                throw new SlurmNotConnectedError('mycluster');
            }
            return { stdout: argv[0] === 'id' ? 'alice\n' : '', stderr: '' };
        });
        service.resetSession('mycluster');

        assert.equal(await service.isAvailable(), true);
        connected = false;
        assert.deepEqual(await service.getJobs(), []);
        assert.deepEqual(await service.getAvailability(), { available: false, reason: 'disconnected', host: 'mycluster' });
    });
});

describe('SlurmService username', () => {
    it('asks where commands run, once per session', async () => {
        const commands: string[] = [];
        const service = createService(async argv => {
            commands.push(argv.join(' '));
            return { stdout: 'alice\n', stderr: '' };
        });

        assert.equal(await service.getUsername(), 'alice');
        assert.equal(await service.getUsername(), 'alice');
        assert.deepEqual(commands, ['id -un']);

        service.resetSession('mycluster');
        await service.getUsername();
        assert.deepEqual(commands, ['id -un', 'id -un']);
    });

    it('does not remember a failed lookup', async () => {
        let connected = false;
        const service = createService(async () => {
            if (!connected) {
                throw new SlurmNotConnectedError('mycluster');
            }
            return { stdout: 'alice\n', stderr: '' };
        });

        assert.equal(await service.getUsername(), undefined);
        connected = true;
        assert.equal(await service.getUsername(), 'alice');
    });

    it('queries jobs for that user, with arguments the shell never sees', async () => {
        const commands: (readonly string[])[] = [];
        const service = createService(async argv => {
            commands.push(argv);
            return { stdout: argv[0] === 'id' ? 'alice\n' : '', stderr: '' };
        });

        await service.getJobs();

        assert.deepEqual(commands[1], ['squeue', '-u', 'alice', '--noheader', '--format=%i|%j|%t|%M|%P|%N|%l|%S|%r|%a|%E']);
    });
});

describe('SlurmService over SSH', () => {
    const squeueLine = '91001|train|R|1:00|h200|gpu-node01|2:00:00|2026-01-01T00:00:00|None|atlas_lab';
    const scontrolOutput = 'JobId=91001 JobName=train Command=/work/alice/train.sbatch WorkDir=/work/alice StdOut=/work/alice/out StdErr=/work/alice/err';

    function remoteRunner(): SlurmCommandRunner {
        return async argv => {
            if (argv[0] === 'id') {
                return { stdout: 'alice\n', stderr: '' };
            }
            if (argv[0] === 'squeue') {
                return { stdout: squeueLine, stderr: '' };
            }
            // The script that runs scontrol for each job, after a marker line
            const [, , , , marker, ...jobIds] = argv;
            return { stdout: jobIds.map(id => `${marker} ${id}\n${scontrolOutput}\n`).join(''), stderr: '' };
        };
    }

    it('does not copy submit scripts, which are on the cluster', async () => {
        const cached: string[] = [];
        const scriptCache = { cacheScript: async (_jobId: string, scriptPath: string) => { cached.push(scriptPath); return undefined; } };

        const local = createService(remoteRunner(), scriptCache);
        await local.getJobs();
        assert.deepEqual(cached, ['/work/alice/train.sbatch']);

        cached.length = 0;
        const remote = createService(remoteRunner(), scriptCache);
        remote.resetSession('mycluster');
        const jobs = await remote.getJobs();
        assert.equal(jobs.length, 1);
        assert.deepEqual(cached, []);
    });

    function withScript(content: string, test: (scriptPath: string) => Promise<void>): Promise<void> {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-submit-'));
        const scriptPath = path.join(dir, 'train.sbatch');
        fs.writeFileSync(scriptPath, content);
        return test(scriptPath).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    }

    it('sends the local script to sbatch, from the folder on the cluster', () => withScript(
        '#!/bin/bash\n#SBATCH -p gpu\npython train.py\n',
        async scriptPath => {
            const calls: { argv: readonly string[]; cwd?: string; input?: string }[] = [];
            const cached: string[] = [];
            const scriptCache = { cacheScript: async (jobId: string) => { cached.push(jobId); return undefined; } };
            const service = createService(async (argv, options) => {
                calls.push({ argv, cwd: options?.cwd, input: options?.input });
                return { stdout: argv[0] === 'sbatch' ? 'Submitted batch job 4242\n' : '', stderr: '' };
            }, scriptCache);
            service.resetSession('mycluster');

            const result = await service.submitJob(scriptPath, '/work/alice/project', 'afterok:41');

            assert.deepEqual(result, { success: true, jobId: '4242', message: 'Job submitted successfully with ID: 4242' });
            assert.deepEqual(calls[0], {
                argv: ['sbatch', '--dependency=afterok:41', '--job-name=train.sbatch'],
                cwd: '/work/alice/project',
                input: '#!/bin/bash\n#SBATCH -p gpu\npython train.py\n',
            });
            // The copy of what was sent is kept, as getJobs can't read it from the cluster
            assert.deepEqual(cached, ['4242']);
        },
    ));

    it('keeps the job name the script gives', () => withScript(
        '#!/bin/bash\n#SBATCH --job-name=vision\npython train.py\n',
        async scriptPath => {
            const calls: (readonly string[])[] = [];
            const service = createService(async argv => {
                calls.push(argv);
                return { stdout: 'Submitted batch job 1\n', stderr: '' };
            });
            service.resetSession('mycluster');

            await service.submitJob(scriptPath, '/work/alice');

            assert.deepEqual(calls[0], ['sbatch']);
        },
    ));

    it('needs a folder on the cluster to submit from', async () => {
        const commands: string[] = [];
        const service = createService(async argv => {
            commands.push(argv.join(' '));
            return { stdout: '', stderr: '' };
        });
        service.resetSession('mycluster');

        const result = await service.submitJob('/home/alice/train.sbatch');

        assert.equal(result.success, false);
        assert.match(result.message, /Choose a folder on mycluster/);
        assert.deepEqual(commands, []);
    });

    it('asks the cluster for the home directory, and uses this machine\'s locally', async () => {
        const service = createService(async argv => ({ stdout: argv[0] === 'printenv' ? '/home/alice\n' : '', stderr: '' }));

        assert.equal(await service.getHomeDirectory(), os.homedir());
        service.resetSession('mycluster');
        assert.equal(await service.getHomeDirectory(), '/home/alice');
    });
});

describe('describeUnavailable', () => {
    it('offers to reconnect when the connection is gone', () => {
        const message = describeUnavailable({ available: false, reason: 'disconnected', host: 'mycluster' }, 'SLURM not available', true);
        assert.equal(message.label, 'Not connected to mycluster');
        assert.equal(message.command?.command, 'slurmClusterManager.connect');
    });

    it('offers to connect over SSH when Slurm is not on this machine', () => {
        const message = describeUnavailable({ available: false, reason: 'missing' }, 'SLURM not available on this system', true);
        assert.equal(message.label, 'SLURM not available on this system');
        assert.equal(message.command?.command, 'slurmClusterManager.connect');
    });

    it('offers nothing where connecting over SSH is not supported', () => {
        const message = describeUnavailable({ available: false, reason: 'missing' }, 'SLURM not available', false);
        assert.equal(message.command, undefined);
    });

    it('names the host when Slurm is missing there', () => {
        const message = describeUnavailable({ available: false, reason: 'missing', host: 'mycluster' }, 'SLURM not available', true);
        assert.equal(message.label, 'SLURM not found on mycluster');
        assert.equal(message.command, undefined);
    });
});

describe('job details', () => {
    it('splits each job\'s scontrol output at its marker', () => {
        const marker = '@@scode-job-0123456789abcdef';
        const stdout = [
            `${marker} 101`,
            'JobId=101 JobName=train',
            '   StdOut=/work/101.out',
            '',
            `${marker} 999`,
            `${marker} 102`,
            'JobId=102 JobName=sweep',
            '',
        ].join('\n');

        assert.deepEqual([...splitMarkedJobOutput(stdout, marker)], [
            ['101', 'JobId=101 JobName=train\n   StdOut=/work/101.out'],
            ['102', 'JobId=102 JobName=sweep'],
        ]);
    });

    it('fetches every job\'s details in one command, whatever the job count', async () => {
        // Stand-ins for squeue and scontrol, run by the real shell script
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-scontrol-'));
        const write = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}`, { mode: 0o755 });
        write('squeue', [
            `echo '101|train|R|1:00|gpu|node01|2:00:00|N/A|None|lab'`,
            `echo '102_3|sweep|R|1:00|gpu|node02|2:00:00|N/A|None|lab'`,
            `echo "103|it's \\$(odd)|PD|0:00|gpu||2:00:00|N/A|Priority|lab"`,
        ].join('\n'));
        // Knows 101 and 103, and 102_3 only by its array's ID, as for a finished array task
        write('scontrol', [
            'echo "$*" >> "$(dirname "$0")/calls"',
            'case "$3" in',
            '  101|103) echo "JobId=$3 StdOut=/work/$3.out StdErr=/work/$3.err WorkDir=/work";;',
            '  102) echo "JobId=102 ArrayTaskId=3 StdOut=/work/array.out WorkDir=/work";;',
            '  *) echo "slurm_load_jobs error: Invalid job id specified" >&2; exit 1;;',
            'esac',
        ].join('\n'));

        const originalPath = process.env.PATH;
        process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
        try {
            const commands: string[] = [];
            const service = createService(async (argv, options) => {
                commands.push(argv[0]);
                return localCommandRunner(argv, options);
            });

            const jobs = await service.getJobs();

            assert.deepEqual(jobs.map(job => [job.jobId, job.stdoutPath]), [
                ['101', '/work/101.out'],
                ['102_3', '/work/array.out'],
                ['103', '/work/103.out'],
            ]);
            // id, squeue, one command for all jobs, and one for the array task's fallback
            assert.deepEqual(commands, ['id', 'squeue', 'sh', 'sh']);
            assert.deepEqual(fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n'), [
                'show job 101', 'show job 102_3', 'show job 103', 'show job 102',
            ]);
        } finally {
            process.env.PATH = originalPath;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('job details between refreshes', () => {
    /** A cluster whose queue the test changes between refreshes, recording which jobs scontrol is asked about */
    function createCluster() {
        const cluster = {
            queue: [] as string[],
            asked: [] as string[][],
            dependencies: new Map<string, string>(),
        };
        const runner: SlurmCommandRunner = async argv => {
            if (argv[0] === 'id') {
                return { stdout: 'alice\n', stderr: '' };
            }
            if (argv[0] === 'squeue') {
                return { stdout: cluster.queue.join('\n'), stderr: '' };
            }
            const [, , , , marker, ...jobIds] = argv;
            cluster.asked.push(jobIds);
            return {
                stdout: jobIds.map(id => {
                    const dependency = cluster.dependencies.get(id) ?? '(null)';
                    return `${marker} ${id}\nJobId=${id} StdOut=/work/${id}.out WorkDir=/work Dependency=${dependency}\n`;
                }).join(''),
                stderr: '',
            };
        };
        return { cluster, service: createService(runner) };
    }

    const row = (id: string, state: string, nodes: string, dependency = '(null)') =>
        `${id}|job${id}|${state}|0:00|gpu|${nodes}|1:00:00|N/A|None|lab|${dependency}`;

    it('asks scontrol only about new jobs and jobs that changed state', async () => {
        const { cluster, service } = createCluster();
        cluster.queue = [row('1', 'R', 'node01'), row('2', 'PD', '')];

        await service.getJobs();
        assert.deepEqual(cluster.asked, [['1', '2']]);

        // Nothing changed: nothing to ask
        const unchanged = await service.getJobs();
        assert.deepEqual(cluster.asked, [['1', '2']]);
        assert.equal(unchanged.find(job => job.jobId === '1')?.stdoutPath, '/work/1.out');

        // Job 2 started and job 3 arrived; job 1 is as it was
        cluster.queue = [row('1', 'R', 'node01'), row('2', 'R', 'node02'), row('3', 'PD', '')];
        await service.getJobs();
        assert.deepEqual(cluster.asked, [['1', '2'], ['2', '3']]);
    });

    it('asks again about a job that left the queue and came back, and after a new session', async () => {
        const { cluster, service } = createCluster();
        cluster.queue = [row('1', 'R', 'node01')];
        await service.getJobs();

        cluster.queue = [];
        await service.getJobs();
        cluster.queue = [row('1', 'R', 'node01')];
        await service.getJobs();
        assert.deepEqual(cluster.asked, [['1'], ['1']]);

        service.resetSession('mycluster');
        await service.getJobs();
        assert.deepEqual(cluster.asked, [['1'], ['1'], ['1']]);
    });

    it('takes the dependency from squeue, so a changed one shows without asking scontrol', async () => {
        const { cluster, service } = createCluster();
        cluster.dependencies.set('2', 'afterok:1(unfulfilled)');
        cluster.queue = [row('2', 'PD', '', 'afterok:1(unfulfilled)')];
        assert.equal((await service.getJobs())[0].dependency, 'afterok:1(unfulfilled)');

        // Cleared with Update Dependency; scontrol's kept answer still has the old one
        cluster.queue = [row('2', 'PD', '')];
        assert.equal((await service.getJobs())[0].dependency, undefined);
        assert.equal(cluster.asked.length, 1);
    });
});
