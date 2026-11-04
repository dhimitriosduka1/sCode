import * as os from 'os';
import * as path from 'path';
import { formatSshHostTarget, SshConfigHost } from './sshConfigHosts';
import { formatTooltipMarkdown, TooltipDetail } from './tooltipMarkdown';

/** Hosts sharing a site. `site` is undefined for the Other group. */
export interface SshHostGroup {
    site: string | undefined;
    hosts: SshConfigHost[];
}

export const OTHER_SSH_HOST_GROUP_LABEL = 'Other';

/**
 * The domain a host belongs to, which groups a cluster's login nodes together:
 * the hostname without its first label (`dais11.mpcdf.mpg.de` is at
 * `mpcdf.mpg.de`), or the whole name when that would leave only a top-level
 * domain (`example.org`). Single-label names and IP addresses have no site.
 */
export function getSshHostSite(host: SshConfigHost): string | undefined {
    const name = (host.hostName ?? host.alias).toLowerCase().replace(/\.$/, '');
    if (!name.includes('.') || name.includes(':') || /^\d+(\.\d+){3}$/.test(name)) {
        return undefined;
    }

    const labels = name.split('.');
    return labels.length > 2 ? labels.slice(1).join('.') : name;
}

/**
 * Groups hosts by site, largest group first and ties in the order the config
 * first mentions them, with Other last. Hosts keep their config order within
 * each group.
 */
export function groupSshHostsBySite(hosts: SshConfigHost[]): SshHostGroup[] {
    const groups = new Map<string | undefined, SshConfigHost[]>();
    for (const host of hosts) {
        const site = getSshHostSite(host);
        const group = groups.get(site);
        if (group) {
            group.push(host);
        } else {
            groups.set(site, [host]);
        }
    }

    // Map iteration follows insertion, and sort is stable, so ties keep config order
    return [...groups.entries()]
        .map(([site, groupHosts]) => ({ site, hosts: groupHosts }))
        .sort((a, b) => {
            if ((a.site === undefined) !== (b.site === undefined)) {
                return a.site === undefined ? 1 : -1;
            }
            return b.hosts.length - a.hosts.length;
        });
}

/**
 * What a host's row shows after its alias. Under a site the group already says
 * where the host is, so the user is enough; under Other, nothing does, so the
 * row shows the whole target.
 */
export function formatSshHostRowDescription(host: SshConfigHost): string {
    if (getSshHostSite(host) === undefined) {
        return formatSshHostTarget(host);
    }

    return host.user ?? '';
}

export function formatSshHostTooltipMarkdown(host: SshConfigHost, homeDir: string = os.homedir()): string {
    const details: TooltipDetail[] = [{ label: 'Host', value: host.hostName ?? host.alias }];
    if (host.user) {
        details.push({ label: 'User', value: host.user });
    }
    if (host.port) {
        details.push({ label: 'Port', value: host.port });
    }
    details.push({ label: 'From', value: shortenHomePath(host.configFile, homeDir) });

    return formatTooltipMarkdown({ title: host.alias, details });
}

function shortenHomePath(filePath: string, homeDir: string): string {
    const relative = path.relative(homeDir, filePath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return filePath;
    }

    return `~/${relative.split(path.sep).join('/')}`;
}
