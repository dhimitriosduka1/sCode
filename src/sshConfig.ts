import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshControlPathResolutionInput {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    tmpDir?: string;
    uid?: number;
}

export function parseSshConfigHosts(content: string): string[] {
    const hosts: string[] = [];
    const seenHosts = new Set<string>();

    for (const rawLine of content.split(/\r?\n/)) {
        const line = stripSshConfigComment(rawLine).trim();
        const match = line.match(/^host\s+(.+)$/i);
        if (!match) {
            continue;
        }

        for (const token of match[1].trim().split(/\s+/)) {
            if (!isSelectableSshHostAlias(token)) {
                continue;
            }

            const key = token.toLowerCase();
            if (!seenHosts.has(key)) {
                hosts.push(token);
                seenHosts.add(key);
            }
        }
    }

    return hosts;
}

export function formatSshBatchModeTestCommand(host: string, input: SshControlPathResolutionInput = {}): string {
    return `ssh ${formatSshControlOptionsForShell(input)} -o BatchMode=yes ${quoteShellArg(host)} id -un`;
}

export function formatSshInteractiveLoginCommand(host: string, input: SshControlPathResolutionInput = {}): string {
    return `ssh ${formatSshControlOptionsForShell(input)} ${quoteShellArg(host)} true`;
}

export function formatSshControlMasterExitCommand(host: string, input: SshControlPathResolutionInput = {}): string {
    if (!supportsSshControlMaster(input.platform)) {
        throw new Error('OpenSSH ControlMaster is not supported on this platform');
    }

    return `ssh ${formatSshControlOptionsForShell(input)} -O exit ${quoteShellArg(host)}`;
}

export function getDefaultSshControlOptions(input: SshControlPathResolutionInput = {}): string[] {
    if (!supportsSshControlMaster(input.platform)) {
        return ['ServerAliveInterval=60'];
    }

    return [
        'ControlMaster=auto',
        'ControlPersist=8h',
        `ControlPath=${getDefaultSshControlPath(input)}`,
        'ServerAliveInterval=60',
    ];
}

export function supportsSshControlMaster(platform: NodeJS.Platform = process.platform): boolean {
    return platform !== 'win32';
}

export function getDefaultSshControlPath(input: SshControlPathResolutionInput = {}): string {
    return resolveDefaultSshControlPath(input);
}

export function resolveDefaultSshControlPath(input: SshControlPathResolutionInput = {}): string {
    const platform = input.platform ?? process.platform;
    const env = input.env ?? process.env;
    const homeDir = input.homeDir ?? os.homedir();
    const tmpDir = input.tmpDir ?? os.tmpdir();
    const uid = input.uid ?? getCurrentUid();

    if (platform === 'linux') {
        const xdgRuntimeDir = normalizeAbsoluteLocalPath(env.XDG_RUNTIME_DIR, platform);
        if (xdgRuntimeDir) {
            return path.posix.join(xdgRuntimeDir, 'slurm-cluster-manager', 'cm-%C');
        }

        const uidSuffix = Number.isInteger(uid) ? String(uid) : 'unknown';
        return path.posix.join(tmpDir, `slurm-cluster-manager-${uidSuffix}`, 'cm-%C');
    }

    if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
        return path.posix.join(homeDir, '.ssh', 'cm-%C');
    }

    return path.join(homeDir, '.ssh', 'cm-%C');
}

export function ensureDefaultSshControlDirectory(): void {
    if (!supportsSshControlMaster()) {
        return;
    }

    const directory = path.dirname(getDefaultSshControlPath());
    try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

        const stat = fs.lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error('path is not a regular directory');
        }

        const uid = getCurrentUid();
        if (uid !== undefined && stat.uid !== uid) {
            throw new Error('directory is not owned by the current user');
        }

        if (process.platform !== 'win32') {
            fs.chmodSync(directory, 0o700);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not prepare SSH control socket directory ${directory}: ${message}`);
    }
}

export function isInteractiveSshAuthFailure(message: string): boolean {
    return /ssh authentication failed/i.test(message) ||
        /password prompts are not supported/i.test(message) ||
        /permission denied.*password/i.test(message);
}

function stripSshConfigComment(line: string): string {
    const commentIndex = line.indexOf('#');
    return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function isSelectableSshHostAlias(token: string): boolean {
    return !!token &&
        !token.startsWith('!') &&
        !token.startsWith('-') &&
        !/[*?\s\0\r\n]/.test(token);
}

function quoteShellArg(value: string): string {
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
        return value;
    }

    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatSshControlOptionsForShell(input: SshControlPathResolutionInput = {}): string {
    return getDefaultSshControlOptions(input)
        .map(option => `-o ${quoteShellArg(option)}`)
        .join(' ');
}

function getCurrentUid(): number | undefined {
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function normalizeAbsoluteLocalPath(value: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
    const isAbsolute = platform === 'linux' || platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd'
        ? path.posix.isAbsolute(value ?? '')
        : path.isAbsolute(value ?? '');
    if (!value || !isAbsolute || /[\0\r\n]/.test(value)) {
        return undefined;
    }

    return value;
}
