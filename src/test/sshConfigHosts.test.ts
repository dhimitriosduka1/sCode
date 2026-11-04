import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatSshHostTarget, globPaths, readSshConfigHosts } from '../sshConfigHosts';

const HOME = '/home/ada';
const CONFIG = '/home/ada/.ssh/config';

function readHostsWithFiles(files: Record<string, string>, globs: Record<string, string[]> = {}) {
    return readSshConfigHosts(CONFIG, {
        homeDir: HOME,
        readFile: (filePath) => files[filePath],
        glob: (pattern) => globs[pattern] ?? [pattern],
    });
}

/** The hosts without the file each came from, which only the Include tests look at. */
function readHosts(files: Record<string, string>, globs: Record<string, string[]> = {}) {
    return readHostsWithFiles(files, globs).map(({ configFile: _configFile, ...host }) => host);
}

describe('readSshConfigHosts', () => {
    it('lists each alias with the settings of its block', () => {
        const hosts = readHosts({
            [CONFIG]: [
                'Host raven',
                '    HostName raven.mpcdf.mpg.de',
                '    User ada',
                '    Port 2222',
                '',
                'Host zeus',
                '    HostName zeus.example.org',
            ].join('\n'),
        });

        assert.deepEqual(hosts, [
            { alias: 'raven', hostName: 'raven.mpcdf.mpg.de', user: 'ada', port: '2222' },
            { alias: 'zeus', hostName: 'zeus.example.org' },
        ]);
    });

    it('gives every alias on a Host line that block\'s settings', () => {
        const hosts = readHosts({ [CONFIG]: 'Host login1 login2\n  HostName login.example.org' });

        assert.deepEqual(hosts.map((host) => [host.alias, host.hostName]), [
            ['login1', 'login.example.org'],
            ['login2', 'login.example.org'],
        ]);
    });

    it('leaves out patterns, and values ssh would read as options, which name no single host', () => {
        const hosts = readHosts({
            [CONFIG]: 'Host *\n  User ada\nHost gpu-?? !bastion *.internal -oProxyCommand=evil cluster\n  HostName c.example.org',
        });

        assert.deepEqual(hosts, [{ alias: 'cluster', hostName: 'c.example.org' }]);
    });

    it('does not apply a Match block\'s settings to the host above it', () => {
        const hosts = readHosts({ [CONFIG]: 'Host raven\n  User ada\nMatch host raven\n  User grace\n  Port 22' });

        assert.deepEqual(hosts, [{ alias: 'raven', user: 'ada' }]);
    });

    it('keeps the first block of an alias declared twice, and its first value of a setting', () => {
        const hosts = readHosts({
            [CONFIG]: 'Host raven\n  HostName first.example.org\n  HostName second.example.org\nHost raven\n  User ada',
        });

        assert.deepEqual(hosts, [{ alias: 'raven', hostName: 'first.example.org' }]);
    });

    it('accepts any keyword case, `=` separators, quotes, comments and CRLF', () => {
        const hosts = readHosts({
            [CONFIG]: [
                '# Clusters',
                'HOST=raven  # trailing comment',
                '  hostname = raven.example.org',
                '  User "ada lovelace"',
            ].join('\r\n'),
        });

        assert.deepEqual(hosts, [{ alias: 'raven', hostName: 'raven.example.org', user: 'ada lovelace' }]);
    });

    it('follows Includes where they appear, resolving them against ~/.ssh', () => {
        const hosts = readHosts(
            {
                [CONFIG]: 'Host first\nInclude config.d/*\nInclude ~/.orbstack/ssh/config\nHost last',
                '/home/ada/.ssh/config.d/a': 'Host from-a',
                '/home/ada/.ssh/config.d/b': 'Host from-b',
                '/home/ada/.orbstack/ssh/config': 'Host orb',
            },
            { '/home/ada/.ssh/config.d/*': ['/home/ada/.ssh/config.d/a', '/home/ada/.ssh/config.d/b'] },
        );

        assert.deepEqual(hosts.map((host) => host.alias), ['first', 'from-a', 'from-b', 'orb', 'last']);
    });

    it('records the file that declared each alias', () => {
        const hosts = readHostsWithFiles(
            { [CONFIG]: 'Host raven\nInclude clusters', '/home/ada/.ssh/clusters': 'Host galvani' },
        );

        assert.deepEqual(hosts.map((host) => [host.alias, host.configFile]), [
            ['raven', CONFIG],
            ['galvani', '/home/ada/.ssh/clusters'],
        ]);
    });

    it('expands %h in HostName to the alias, as ssh does', () => {
        const hosts = readHosts({ [CONFIG]: 'Host raven zeus\n  HostName %h.example.org' });

        assert.deepEqual(hosts.map((host) => host.hostName), ['raven.example.org', 'zeus.example.org']);
    });

    it('stops at Includes that loop back on themselves', () => {
        const hosts = readHosts({ [CONFIG]: 'Host raven\nInclude config' });

        assert.deepEqual(hosts.map((host) => host.alias), ['raven']);
    });

    it('lists nothing when there is no config', () => {
        assert.deepEqual(readHosts({}), []);
    });
});

describe('formatSshHostTarget', () => {
    it('shows where an alias leads, leaving out what the config does not set', () => {
        assert.equal(formatSshHostTarget({ alias: 'raven', configFile: CONFIG, hostName: 'raven.example.org', user: 'ada', port: '2222' }), 'ada@raven.example.org:2222');
        assert.equal(formatSshHostTarget({ alias: 'raven', configFile: CONFIG, user: 'ada' }), 'ada@raven');
        assert.equal(formatSshHostTarget({ alias: 'raven', configFile: CONFIG }), 'raven');
    });
});

describe('globPaths', () => {
    it('expands wildcards in any segment in sorted order, skipping dotfiles', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-glob-'));
        try {
            for (const dir of ['a.d', 'b.d']) {
                fs.mkdirSync(path.join(root, dir));
            }
            for (const file of ['a.d/2.conf', 'a.d/1.conf', 'a.d/.hidden.conf', 'b.d/3.conf', 'b.d/notes.txt']) {
                fs.writeFileSync(path.join(root, file), '');
            }

            assert.deepEqual(globPaths(path.join(root, '*.d', '*.conf')), [
                path.join(root, 'a.d', '1.conf'),
                path.join(root, 'a.d', '2.conf'),
                path.join(root, 'b.d', '3.conf'),
            ]);
            assert.deepEqual(globPaths(path.join(root, 'missing', '*')), []);
            assert.deepEqual(globPaths(path.join(root, 'plain')), [path.join(root, 'plain')]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
