import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SshExecutor, parseSshConfigHosts } from '../sshExecutor';

describe('SshExecutor Tests', () => {
    it('correctly constructs the ControlMaster socket path under os.tmpdir()', () => {
        const remoteHost = 'my-remote-cluster';
        const executor = new SshExecutor(remoteHost);
        const socketBasename = path.basename(executor['socketPath']);
        
        // The socket filename should contain the sanitized remoteHost
        assert.ok(socketBasename.includes('slurm_ssh_my-remote-cluster.sock'));
        assert.ok(executor['socketPath'].length < 104); // Must satisfy Unix socket path length limit
    });

    it('sanitizes special characters in the host name for socket file name safety', () => {
        const executor = new SshExecutor('user@host.subdomain-name.com:22');
        const socketBasename = path.basename(executor['socketPath']);
        assert.ok(!socketBasename.includes('@'));
        assert.ok(!socketBasename.replace('.sock', '').includes('.'));
        assert.ok(!socketBasename.includes(':'));
        assert.ok(socketBasename.includes('user_host_subdomain-name_com_22'));
    });

    it('correctly builds standard multiplexed SSH command', () => {
        const executor = new SshExecutor('my-cluster');
        const sshCommand = executor.buildSshCommand('squeue');
        
        assert.ok(sshCommand.startsWith('ssh '));
        assert.ok(sshCommand.includes('"-o" "ControlMaster=auto"'));
        assert.ok(sshCommand.includes('"-o" "ControlPath='));
        assert.ok(sshCommand.includes('"-o" "ControlPersist=10m"'));
        assert.ok(sshCommand.includes('"my-cluster"'));
        assert.ok(sshCommand.includes('"squeue"'));
    });

    it('correctly builds remote SSH command with working directory change', () => {
        const executor = new SshExecutor('my-cluster');
        const sshCommand = executor.buildSshCommand('squeue', '/home/user/my_project');
        
        assert.ok(sshCommand.includes('"cd \'/home/user/my_project\' && squeue"'));
    });

    it('escapes double quotes, dollar signs, and backticks to prevent shell injection', () => {
        const executor = new SshExecutor('my-cluster');
        const input = 'echo "hello" && echo $USER && echo `uname`';
        const escaped = executor.escapeDoubleQuotes(input);
        
        assert.equal(escaped, 'echo \\"hello\\" && echo \\$USER && echo \\`uname\\`');
    });

    it('escapes single quotes correctly using shell argument escaping', () => {
        const executor = new SshExecutor('my-cluster');
        const input = "/path/with/'single'_quote";
        const escaped = executor.escapeShellArg(input);
        
        assert.equal(escaped, "'/path/with/'\\''single'\\''_quote'");
    });
});

describe('parseSshConfigHosts Tests', () => {
    /**
     * Helper: write a temporary SSH config file and return its path.
     */
    function writeTempSshConfig(content: string): string {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-config-test-'));
        const configPath = path.join(tmpDir, 'config');
        fs.writeFileSync(configPath, content, 'utf8');
        return configPath;
    }

    it('returns empty array when ssh config file does not exist', () => {
        const nonExistentPath = path.join(os.tmpdir(), 'no-such-ssh-config-file-xyz.cfg');
        const hosts = parseSshConfigHosts(nonExistentPath);
        assert.deepEqual(hosts, []);
    });

    it('parses a single named host entry', () => {
        const configPath = writeTempSshConfig(`Host my-cluster\n    HostName slurm.university.edu\n    User alice\n`);
        const hosts = parseSshConfigHosts(configPath);
        assert.ok(hosts.includes('my-cluster'), `Expected 'my-cluster' in [${hosts.join(', ')}]`);
        assert.equal(hosts.length, 1);
    });

    it('ignores wildcard Host * entries', () => {
        const configPath = writeTempSshConfig(`Host *\n    ServerAliveInterval 60\n`);
        const hosts = parseSshConfigHosts(configPath);
        assert.deepEqual(hosts, []);
    });

    it('ignores single-character wildcard Host ? entries', () => {
        const configPath = writeTempSshConfig(`Host ?\n    StrictHostKeyChecking no\n`);
        const hosts = parseSshConfigHosts(configPath);
        assert.deepEqual(hosts, []);
    });

    it('handles multiple named hosts on a single Host line', () => {
        const configPath = writeTempSshConfig(`Host hostA hostB hostC\n    HostName example.com\n`);
        const hosts = parseSshConfigHosts(configPath);
        assert.ok(hosts.includes('hostA'), `Expected 'hostA' in [${hosts.join(', ')}]`);
        assert.ok(hosts.includes('hostB'), `Expected 'hostB' in [${hosts.join(', ')}]`);
        assert.ok(hosts.includes('hostC'), `Expected 'hostC' in [${hosts.join(', ')}]`);
        assert.equal(hosts.length, 3);
    });

    it('parses multiple Host stanzas', () => {
        const configPath = writeTempSshConfig(
            `Host cluster1\n    HostName c1.example.com\n\nHost cluster2\n    HostName c2.example.com\n`
        );
        const hosts = parseSshConfigHosts(configPath);
        assert.ok(hosts.includes('cluster1'));
        assert.ok(hosts.includes('cluster2'));
        assert.equal(hosts.length, 2);
    });

    it('deduplicates host names that appear more than once', () => {
        const configPath = writeTempSshConfig(`Host my-cluster\n    HostName slurm.edu\n\nHost my-cluster\n    HostName slurm2.edu\n`);
        const hosts = parseSshConfigHosts(configPath);
        assert.equal(hosts.filter(h => h === 'my-cluster').length, 1, 'Duplicate host should appear only once');
    });

    it('mixes wildcard and named hosts and filters wildcards out', () => {
        const configPath = writeTempSshConfig(
            `Host *\n    ServerAliveInterval 60\n\nHost my-gpu-cluster\n    HostName gpu.hpc.edu\n    User researcher\n\nHost ?\n    StrictHostKeyChecking no\n`
        );
        const hosts = parseSshConfigHosts(configPath);
        assert.deepEqual(hosts, ['my-gpu-cluster']);
    });

    it('is case-insensitive for the Host keyword', () => {
        const configPath = writeTempSshConfig(`HOST case-test-host\n    HostName example.com\n`);
        const hosts = parseSshConfigHosts(configPath);
        assert.ok(hosts.includes('case-test-host'), `Expected 'case-test-host' in [${hosts.join(', ')}]`);
    });
});
