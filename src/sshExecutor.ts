import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

/**
 * Executes system ssh/scp commands over a shared ControlMaster socket
 * for high-performance zero-handshake remote cluster communication.
 */
export class SshExecutor {
    private socketPath: string;

    constructor(private remoteHost: string) {
        // Use os.tmpdir() with a safe, short filename to prevent Unix domain socket path length limits (104 characters)
        const sanitizedHost = remoteHost.replace(/[^a-zA-Z0-9_-]/g, '_');
        this.socketPath = path.join(os.tmpdir(), `slurm_ssh_${sanitizedHost}.sock`);
    }

    /**
     * Get the standard SSH options for ControlMaster multiplexing
     */
    private getSshOptions(): string[] {
        return [
            '-o', 'ControlMaster=auto',
            '-o', `ControlPath=${this.socketPath}`,
            '-o', 'ControlPersist=10m'
        ];
    }

    /**
     * Build full SSH command string
     */
    public buildSshCommand(cmd: string, cwd?: string): string {
        const sshOpts = this.getSshOptions().map(opt => `"${opt}"`).join(' ');
        const remoteCmd = cwd ? `cd ${this.escapeShellArg(cwd)} && ${cmd}` : cmd;
        return `ssh ${sshOpts} "${this.remoteHost}" "${this.escapeDoubleQuotes(remoteCmd)}"`;
    }

    /**
     * Execute command on the remote host over SSH
     */
    async execute(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string }> {
        const sshCmd = this.buildSshCommand(cmd, cwd);
        try {
            const { stdout, stderr } = await execAsync(sshCmd);
            return {
                stdout: stdout.toString(),
                stderr: stderr.toString()
            };
        } catch (error: any) {
            return {
                stdout: error.stdout ? error.stdout.toString() : '',
                stderr: error.stderr ? error.stderr.toString() : error.message || String(error)
            };
        }
    }

    /**
     * Copy a local file to the remote host using scp over the multiplexed connection
     */
    async copyFile(localPath: string, remotePath: string): Promise<{ success: boolean; message: string }> {
        const scpOpts = this.getSshOptions().map(opt => `"${opt}"`).join(' ');
        // Ensure remote directory exists
        const remoteDir = path.dirname(remotePath);
        await this.execute(`mkdir -p "${this.escapeDoubleQuotes(remoteDir)}"`);

        const scpCmd = `scp ${scpOpts} "${localPath}" "${this.remoteHost}:${this.escapeDoubleQuotes(remotePath)}"`;
        try {
            await execAsync(scpCmd);
            return { success: true, message: 'File copied successfully' };
        } catch (error: any) {
            return {
                success: false,
                message: error.stderr ? error.stderr.toString() : error.message || String(error)
            };
        }
    }

    /**
     * Read remote file content
     */
    async readFile(remotePath: string): Promise<string> {
        const result = await this.execute(`cat "${this.escapeDoubleQuotes(remotePath)}"`);
        if (result.stderr && !result.stdout) {
            throw new Error(`Failed to read remote file: ${result.stderr}`);
        }
        return result.stdout;
    }

    /**
     * Stat a remote file (checks existence, size, and whether it is a directory)
     */
    async stat(remotePath: string): Promise<{ size: number; isDirectory: boolean }> {
        const cmd = `if [ -d "${this.escapeDoubleQuotes(remotePath)}" ]; then echo "0|d"; elif [ -f "${this.escapeDoubleQuotes(remotePath)}" ]; then wc -c "${this.escapeDoubleQuotes(remotePath)}" | awk '{print $1"|f"}'; else echo "-1|unknown"; fi`;
        const result = await this.execute(cmd);
        const parts = result.stdout.trim().split('|');
        if (parts.length === 2) {
            const size = parseInt(parts[0], 10);
            const type = parts[1];
            if (size >= 0) {
                return {
                    size: size,
                    isDirectory: type === 'd'
                };
            }
        }
        throw new Error(`File or directory does not exist: ${remotePath}`);
    }

    /**
     * Clean up the background ControlMaster multiplexing socket
     */
    async cleanup(): Promise<void> {
        const sshOpts = this.getSshOptions().map(opt => `"${opt}"`).join(' ');
        try {
            await execAsync(`ssh ${sshOpts} -O exit "${this.remoteHost}" 2>/dev/null`);
        } catch {
            // Ignore failure if it was already closed
        }
        try {
            if (fs.existsSync(this.socketPath)) {
                fs.unlinkSync(this.socketPath);
            }
        } catch {
            // Ignore filesystem cleanup errors
        }
    }

    /**
     * Escapes double quotes in strings to prevent shell injection or escape sequence issues
     */
    public escapeDoubleQuotes(str: string): string {
        return str.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
    }

    /**
     * Escapes single quotes for shell argument safety
     */
    public escapeShellArg(arg: string): string {
        return `'${arg.replace(/'/g, "'\\''")}'`;
    }
}

/**
 * Parse ssh config from user homedir (or custom path) to retrieve hosts.
 */
export function parseSshConfigHosts(customPath?: string): string[] {
    const hosts: string[] = [];
    const sshConfigPath = customPath || path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(sshConfigPath)) {
        return hosts;
    }
    try {
        const content = fs.readFileSync(sshConfigPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().startsWith('host ')) {
                const hostParts = trimmed.slice(5).trim().split(/\s+/);
                for (const part of hostParts) {
                    const hostName = part.trim();
                    if (hostName && !hostName.includes('*') && !hostName.includes('?')) {
                        hosts.push(hostName);
                    }
                }
            }
        }
    } catch (err) {
        console.error('Failed to parse SSH config:', err);
    }
    return Array.from(new Set(hosts));
}
