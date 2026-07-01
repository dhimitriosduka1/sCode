import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { SSHProfile } from './sshSession';

const execAsync = promisify(exec);

/**
 * Helper to build common SSH connection arguments from a profile
 */
export function buildSSHArgs(profile: SSHProfile): string[] {
    const args: string[] = [];
    if (profile.port) {
        args.push('-p', String(profile.port));
    }
    if (profile.identityFile) {
        args.push('-i', profile.identityFile);
    }
    const destination = profile.username
        ? `${profile.username}@${profile.host}`
        : profile.host;
    args.push(destination);
    return args;
}

/**
 * Uploads a local file to the remote host using scp.
 * Uses control options if available, otherwise runs normal scp.
 */
export async function uploadFile(
    profile: SSHProfile,
    localPath: string,
    remotePath: string,
): Promise<void> {
    const args: string[] = ['-o', 'StrictHostKeyChecking=accept-new'];

    // NOTE: scp uses capital -P for Port, unlike ssh which uses lowercase -p!
    if (profile.port) {
        args.push('-P', String(profile.port));
    }
    if (profile.identityFile) {
        args.push('-i', profile.identityFile);
    }

    const destinationHost = profile.username
        ? `${profile.username}@${profile.host}`
        : profile.host;

    // Command structure: scp [options] "localPath" "user@host:remotePath"
    const command = [
        'scp',
        ...args,
        `"${localPath.replace(/"/g, '\\"')}"`,
        `"${destinationHost}:${remotePath.replace(/"/g, '\\"')}"`
    ].join(' ');

    await execAsync(command);
}

/**
 * Queries the remote cluster to locate script files in a given directory.
 */
export async function listRemoteScripts(
    profile: SSHProfile,
    remoteDir: string,
    execCommand: (cmd: string) => Promise<{ stdout: string; stderr: string }>,
): Promise<string[]> {
    // Run find command remotely to list scripts up to 3 levels deep
    const escapedDir = remoteDir.replace(/"/g, '\\"');
    const findCmd = `find "${escapedDir}" -maxdepth 3 -type f \\( -name "*.sh" -o -name "*.slurm" -o -name "*.sbatch" \\) 2>/dev/null`;

    try {
        const result = await execCommand(findCmd);
        return result.stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => !!line);
    } catch (err) {
        console.error(`Failed to list remote scripts in ${remoteDir}:`, err);
        return [];
    }
}
