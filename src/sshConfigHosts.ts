import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A host the user can `ssh` to by name, as declared in their SSH config. */
export interface SshConfigHost {
    /** The alias from the `Host` line, which is what `ssh <alias>` takes. */
    alias: string;
    hostName?: string;
    user?: string;
    port?: string;
}

/** Reads the file at a path, or returns undefined when it cannot be read. */
export type SshConfigFileReader = (filePath: string) => string | undefined;

/** Lists the paths an `Include` pattern matches, in the order ssh reads them. */
export type SshConfigGlob = (pattern: string) => string[];

export interface SshConfigReadOptions {
    readFile?: SshConfigFileReader;
    glob?: SshConfigGlob;
    homeDir?: string;
}

// ssh itself refuses to nest Includes deeper than this
const MAX_INCLUDE_DEPTH = 16;

/** The user's SSH config, which is where `ssh` and Remote - SSH take host aliases from. */
export function getDefaultSshConfigPath(homeDir: string = os.homedir()): string {
    return path.join(homeDir, '.ssh', 'config');
}

/**
 * Lists the hosts an SSH config declares, following its `Include`s, in the order
 * ssh reads them. Patterns (`*`, `?`, `!negated`) name no single host and are
 * left out, as are `Match` blocks. An alias declared twice keeps its first block,
 * since that is the one ssh applies first.
 */
export function readSshConfigHosts(
    configPath: string = getDefaultSshConfigPath(),
    options: SshConfigReadOptions = {},
): SshConfigHost[] {
    const homeDir = options.homeDir ?? os.homedir();
    const readFile = options.readFile ?? readFileIfPresent;
    const glob = options.glob ?? globPaths;
    // Relative Include paths in the user config resolve against ~/.ssh
    const sshDir = path.join(homeDir, '.ssh');

    const hosts = new Map<string, SshConfigHost>();
    const visit = (filePath: string, depth: number) => {
        const text = depth <= MAX_INCLUDE_DEPTH ? readFile(filePath) : undefined;
        if (text === undefined) {
            return;
        }

        // Settings apply to every alias of the Host line they follow
        let currentBlock: SshConfigHost[] = [];
        for (const { keyword, args } of parseSshConfigLines(text)) {
            if (keyword === 'host') {
                currentBlock = [];
                for (const alias of args) {
                    if (isHostPattern(alias) || hosts.has(alias)) {
                        continue;
                    }
                    const host: SshConfigHost = { alias };
                    hosts.set(alias, host);
                    currentBlock.push(host);
                }
            } else if (keyword === 'match') {
                currentBlock = [];
            } else if (keyword === 'include') {
                for (const pattern of args) {
                    for (const includedPath of glob(resolveIncludePath(pattern, homeDir, sshDir))) {
                        visit(includedPath, depth + 1);
                    }
                }
            } else if (args.length > 0) {
                for (const host of currentBlock) {
                    applyHostSetting(host, keyword, args[0]);
                }
            }
        }
    };

    visit(configPath, 0);
    return [...hosts.values()];
}

/** Where an alias leads, as `user@hostname:port`, leaving out what the config does not set. */
export function formatSshHostTarget(host: SshConfigHost): string {
    const user = host.user ? `${host.user}@` : '';
    const port = host.port ? `:${host.port}` : '';
    return `${user}${host.hostName ?? host.alias}${port}`;
}

interface SshConfigLine {
    /** Lower-cased, since ssh matches keywords case-insensitively. */
    keyword: string;
    args: string[];
}

/** Splits an SSH config into keyword lines, skipping blanks and comments. */
export function parseSshConfigLines(text: string): SshConfigLine[] {
    const lines: SshConfigLine[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) {
            continue;
        }

        // Keyword and arguments are split by whitespace or a single `=`
        const match = line.match(/^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/);
        if (!match) {
            continue;
        }
        lines.push({ keyword: match[1].toLowerCase(), args: splitSshConfigArgs(match[2]) });
    }

    return lines;
}

/** Splits arguments on whitespace, keeping double-quoted ones whole. */
function splitSshConfigArgs(value: string): string[] {
    const args: string[] = [];
    const pattern = /"([^"]*)"|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
        const arg = match[1] ?? match[2];
        // An unquoted `#` starts a trailing comment
        if (match[2] !== undefined && arg.startsWith('#')) {
            break;
        }
        args.push(arg);
    }

    return args;
}

function isHostPattern(alias: string): boolean {
    return alias.includes('*') || alias.includes('?') || alias.startsWith('!');
}

function applyHostSetting(host: SshConfigHost, keyword: string, value: string): void {
    // The first value for each setting wins, as in ssh
    if (keyword === 'hostname') {
        host.hostName ??= value;
    } else if (keyword === 'user') {
        host.user ??= value;
    } else if (keyword === 'port') {
        host.port ??= value;
    }
}

function resolveIncludePath(pattern: string, homeDir: string, sshDir: string): string {
    if (pattern === '~' || pattern.startsWith('~/')) {
        return path.join(homeDir, pattern.slice(1));
    }

    return path.isAbsolute(pattern) ? pattern : path.join(sshDir, pattern);
}

function readFileIfPresent(filePath: string): string | undefined {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * Expands `*` and `?` in any part of an absolute path, as ssh's Include does,
 * listing matches in sorted order. A path without wildcards is returned as is,
 * whether or not it exists, since reading it is what decides.
 */
export function globPaths(pattern: string): string[] {
    const { root } = path.parse(pattern);
    const segments = pattern.slice(root.length).split(/[\\/]+/).filter(Boolean);

    let matches = [root];
    for (const segment of segments) {
        if (!/[*?]/.test(segment)) {
            matches = matches.map((dir) => path.join(dir, segment));
            continue;
        }

        const segmentPattern = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
        matches = matches.flatMap((dir) => {
            try {
                return fs.readdirSync(dir)
                    // As in shell globs, a wildcard does not match a leading dot
                    .filter((name) => segmentPattern.test(name) && (!name.startsWith('.') || segment.startsWith('.')))
                    .sort()
                    .map((name) => path.join(dir, name));
            } catch {
                return [];
            }
        });
    }

    return matches;
}
