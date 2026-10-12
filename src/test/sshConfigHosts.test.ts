import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { readSshConfigHosts, SshConfigFileSystem } from '../sshConfigHosts';

/** An in-memory file system holding the given files */
function filesystem(files: Record<string, string>): SshConfigFileSystem {
    return {
        readFile: filePath => {
            if (!(filePath in files)) {
                throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
            }
            return files[filePath];
        },
        readDir: dirPath => Object.keys(files)
            .filter(filePath => path.dirname(filePath) === dirPath)
            .map(filePath => path.basename(filePath)),
    };
}

const CONFIG = '/home/me/.ssh/config';

describe('readSshConfigHosts', () => {
    it('lists named hosts with their address, in order', () => {
        const hosts = readSshConfigHosts(CONFIG, filesystem({
            [CONFIG]: [
                '# Clusters',
                'Host raven',
                '    HostName raven.mpcdf.mpg.de',
                '    User alice',
                '',
                'Host viper viper-gpu',
                '  Hostname=viper.mpcdf.mpg.de',
                'host github.com',
                '  IdentityFile ~/.ssh/github',
            ].join('\n'),
        }));

        assert.deepEqual(hosts, [
            { alias: 'raven', hostName: 'raven.mpcdf.mpg.de', user: 'alice' },
            { alias: 'viper', hostName: 'viper.mpcdf.mpg.de' },
            { alias: 'viper-gpu', hostName: 'viper.mpcdf.mpg.de' },
            { alias: 'github.com' },
        ]);
    });

    it('leaves out patterns, which name no single host', () => {
        const hosts = readSshConfigHosts(CONFIG, filesystem({
            [CONFIG]: 'Host *\n  ServerAliveInterval 60\nHost gpu-node?? !bastion raven *.example.org\n',
        }));

        assert.deepEqual(hosts.map(host => host.alias), ['raven']);
    });

    it('keeps the first address given, as ssh does', () => {
        const hosts = readSshConfigHosts(CONFIG, filesystem({
            [CONFIG]: 'Host raven\n  HostName first.example.org\nHost raven\n  HostName second.example.org\n',
        }));

        assert.deepEqual(hosts, [{ alias: 'raven', hostName: 'first.example.org' }]);
    });

    it('does not apply Match blocks to the host before them', () => {
        const hosts = readSshConfigHosts(CONFIG, filesystem({
            [CONFIG]: 'Host raven\nMatch exec "true"\n  HostName elsewhere.example.org\n',
        }));

        assert.deepEqual(hosts, [{ alias: 'raven' }]);
    });

    it('follows Include, relative to ~/.ssh and with wildcards', () => {
        const hosts = readSshConfigHosts(CONFIG, filesystem({
            [CONFIG]: 'Include config.d/*.conf "extra config"\nHost local\n',
            '/home/me/.ssh/config.d/b.conf': 'Host bravo\n',
            '/home/me/.ssh/config.d/a.conf': 'Host alpha\n  Include nested\n',
            '/home/me/.ssh/config.d/notes.txt': 'Host ignored\n',
            '/home/me/.ssh/nested': 'Host nested-host\n',
            '/home/me/.ssh/extra config': 'Host quoted\n',
        }));

        assert.deepEqual(hosts.map(host => host.alias), ['alpha', 'nested-host', 'bravo', 'quoted', 'local']);
    });

    it('expands ~ in Include paths', () => {
        const included = path.join(os.homedir(), 'cluster-hosts');
        const hosts = readSshConfigHosts(CONFIG, filesystem({
            [CONFIG]: 'Include ~/cluster-hosts\n',
            [included]: 'Host from-home\n',
        }));

        assert.deepEqual(hosts.map(host => host.alias), ['from-home']);
    });

    it('stops at Include loops', () => {
        const hosts = readSshConfigHosts(CONFIG, filesystem({
            [CONFIG]: 'Host raven\nInclude config\n',
        }));

        assert.deepEqual(hosts.map(host => host.alias), ['raven']);
    });

    it('has no hosts without a config', () => {
        assert.deepEqual(readSshConfigHosts(CONFIG, filesystem({})), []);
    });
});
