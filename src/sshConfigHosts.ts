import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A host someone can connect to by name, from their SSH config */
export interface SshConfigHost {
    alias: string;
    hostName?: string;
    user?: string;
}

export interface SshConfigFileSystem {
    readFile(filePath: string): string;
    readDir(dirPath: string): string[];
}

const nodeFileSystem: SshConfigFileSystem = {
    readFile: filePath => fs.readFileSync(filePath, 'utf8'),
    readDir: dirPath => fs.readdirSync(dirPath),
};

/** Include can nest; OpenSSH stops at 16 levels, and so does this */
const MAX_INCLUDE_DEPTH = 16;

export function getUserSshConfigPath(): string {
    return path.join(os.homedir(), '.ssh', 'config');
}

/**
 * The hosts in an SSH config that can be connected to by name, in the order
 * they appear, following Include as OpenSSH does. Patterns (`*`, `?`, `!`)
 * name no single host, so they're left out.
 */
export function readSshConfigHosts(
    configPath: string = getUserSshConfigPath(),
    fileSystem: SshConfigFileSystem = nodeFileSystem,
): SshConfigHost[] {
    const hosts = new Map<string, SshConfigHost>();
    collectHosts(configPath, path.dirname(configPath), 0, hosts, fileSystem);
    return [...hosts.values()];
}

function collectHosts(
    filePath: string,
    sshDir: string,
    depth: number,
    hosts: Map<string, SshConfigHost>,
    fileSystem: SshConfigFileSystem,
): void {
    let text: string;
    try {
        text = fileSystem.readFile(filePath);
    } catch {
        // A missing config, or an Include that matches nothing, is no error to ssh either
        return;
    }

    // The hosts the current Host block's settings apply to
    let block: SshConfigHost[] = [];

    for (const line of text.split(/\r?\n/)) {
        const parsed = parseConfigLine(line);
        if (!parsed) {
            continue;
        }

        const [keyword, ...args] = parsed;
        switch (keyword) {
            case 'host':
                block = args.filter(isConcreteAlias).map(alias => {
                    const host = hosts.get(alias) ?? { alias };
                    hosts.set(alias, host);
                    return host;
                });
                break;
            case 'match':
                // Applies by condition, not to hosts by name
                block = [];
                break;
            case 'hostname':
                // As in ssh, the first value given wins
                block.forEach(host => { host.hostName ??= args[0]; });
                break;
            case 'user':
                block.forEach(host => { host.user ??= args[0]; });
                break;
            case 'include':
                if (depth < MAX_INCLUDE_DEPTH) {
                    for (const included of args.flatMap(pattern => resolveInclude(pattern, sshDir, fileSystem))) {
                        collectHosts(included, sshDir, depth + 1, hosts, fileSystem);
                    }
                }
                break;
        }
    }
}

/** A line's lowercased keyword and its arguments, or undefined for blank lines and comments */
function parseConfigLine(line: string): string[] | undefined {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return undefined;
    }

    // `Keyword value` and `Keyword=value` are both allowed
    const match = trimmed.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
    if (!match) {
        return [trimmed.toLowerCase()];
    }

    const args = [...match[2].matchAll(/"([^"]*)"|(\S+)/g)].map(arg => arg[1] ?? arg[2]);
    return [match[1].toLowerCase(), ...args];
}

function isConcreteAlias(alias: string): boolean {
    return alias.length > 0 && !/[*?]/.test(alias) && !alias.startsWith('!');
}

/** Include paths are relative to ~/.ssh, may start with ~, and may use wildcards in the file name */
function resolveInclude(pattern: string, sshDir: string, fileSystem: SshConfigFileSystem): string[] {
    const expanded = pattern === '~' || pattern.startsWith('~/')
        ? path.join(os.homedir(), pattern.slice(1))
        : pattern;
    const absolute = path.isAbsolute(expanded) ? expanded : path.join(sshDir, expanded);

    const fileName = path.basename(absolute);
    if (!/[*?]/.test(fileName)) {
        return [absolute];
    }

    const dir = path.dirname(absolute);
    const matcher = new RegExp(`^${fileName.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    try {
        return fileSystem.readDir(dir).filter(name => matcher.test(name)).sort().map(name => path.join(dir, name));
    } catch {
        return [];
    }
}
