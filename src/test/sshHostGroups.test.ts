import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SshConfigHost } from '../sshConfigHosts';
import {
    formatSshHostRowDescription,
    formatSshHostTooltipMarkdown,
    getSshHostSite,
    groupSshHostsBySite,
} from '../sshHostGroups';

const CONFIG = '/home/ada/.ssh/config';

function host(alias: string, hostName?: string, user?: string): SshConfigHost {
    return { alias, configFile: CONFIG, hostName, user };
}

describe('getSshHostSite', () => {
    it('drops the first label, so a cluster\'s login nodes share a site', () => {
        assert.equal(getSshHostSite(host('dais', 'dais11.mpcdf.mpg.de')), 'mpcdf.mpg.de');
        assert.equal(getSshHostSite(host('galvani', 'galvani-login.mlcloud.uni-tuebingen.de')), 'mlcloud.uni-tuebingen.de');
    });

    it('keeps a two-label name whole, rather than grouping by top-level domain', () => {
        assert.equal(getSshHostSite(host('box', 'example.org')), 'example.org');
    });

    it('falls back to the alias, and ignores case and a trailing dot', () => {
        assert.equal(getSshHostSite(host('slurm-submit.mpi-inf.mpg.de')), 'mpi-inf.mpg.de');
        assert.equal(getSshHostSite(host('raven', 'Raven.MPCDF.mpg.de.')), 'mpcdf.mpg.de');
    });

    it('gives single-label names and IP addresses no site', () => {
        assert.equal(getSshHostSite(host('zeus', 'wks-24-0131')), undefined);
        assert.equal(getSshHostSite(host('lab', '10.0.0.12')), undefined);
        assert.equal(getSshHostSite(host('lab6', 'fe80::1')), undefined);
    });
});

describe('groupSshHostsBySite', () => {
    it('puts the largest site first, ties in config order and Other last, keeping config order within each', () => {
        const groups = groupSshHostsBySite([
            host('slurm-submit.mpi-inf.mpg.de'),
            host('zeus', 'wks-24-0131'),
            host('dais', 'dais11.mpcdf.mpg.de'),
            host('galvani', 'galvani-login.mlcloud.uni-tuebingen.de'),
            host('raven', 'raven.mpcdf.mpg.de'),
            host('ferranti', 'ferranti-login.mlcloud.uni-tuebingen.de'),
            host('cobra', 'cobra.mpcdf.mpg.de'),
            host('lab', '10.0.0.12'),
        ]);

        assert.deepEqual(groups.map((group) => [group.site, group.hosts.map((h) => h.alias)]), [
            ['mpcdf.mpg.de', ['dais', 'raven', 'cobra']],
            ['mlcloud.uni-tuebingen.de', ['galvani', 'ferranti']],
            ['mpi-inf.mpg.de', ['slurm-submit.mpi-inf.mpg.de']],
            [undefined, ['zeus', 'lab']],
        ]);
    });

    it('lists nothing when there are no hosts', () => {
        assert.deepEqual(groupSshHostsBySite([]), []);
    });
});

describe('formatSshHostRowDescription', () => {
    it('shows only the user under a site, which already says where the host is', () => {
        assert.equal(formatSshHostRowDescription(host('raven', 'raven.mpcdf.mpg.de', 'ada')), 'ada');
        assert.equal(formatSshHostRowDescription(host('raven', 'raven.mpcdf.mpg.de')), '');
    });

    it('shows the whole target under Other, where nothing else does', () => {
        assert.equal(formatSshHostRowDescription(host('zeus', 'wks-24-0131', 'ada')), 'ada@wks-24-0131');
    });
});

describe('formatSshHostTooltipMarkdown', () => {
    it('lists the settings the config gives, and the file it came from relative to home', () => {
        assert.equal(
            formatSshHostTooltipMarkdown({ ...host('raven', 'raven.mpcdf.mpg.de', 'ada'), port: '2222' }, '/home/ada'),
            '**raven**\n\n- **Host:** raven.mpcdf.mpg.de\n- **User:** ada\n- **Port:** 2222\n- **From:** ~/.ssh/config',
        );
    });

    it('falls back to the alias for the host and keeps paths outside home whole', () => {
        assert.equal(
            formatSshHostTooltipMarkdown({ alias: 'zeus', configFile: '/etc/ssh/extra' }, '/home/ada'),
            '**zeus**\n\n- **Host:** zeus\n- **From:** /etc/ssh/extra',
        );
    });
});
