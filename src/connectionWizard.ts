import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SSHProfile } from './sshSession';

/**
 * Runs a multi-step user configuration flow to set up an SSH connection profile.
 */
export async function runConnectionWizard(): Promise<SSHProfile | undefined> {
    // Step 1: Choose entry mode
    const modeSelection = await vscode.window.showQuickPick([
        { label: '$(gear) Import from SSH Config', description: 'Import host settings from ~/.ssh/config', value: 'config' },
        { label: '$(edit) Enter manually', description: 'Input host details manually', value: 'manual' }
    ], {
        placeHolder: 'Choose SSH setup method',
        title: 'SLURM SSH: Add Connection Profile'
    });

    if (!modeSelection) {
        return undefined; // User cancelled
    }

    let profileData: Partial<SSHProfile>;

    if (modeSelection.value === 'config') {
        const configProfiles = parseSSHConfig();
        if (configProfiles.length === 0) {
            vscode.window.showWarningMessage('No Host profiles found in ~/.ssh/config. Switching to manual input.');
            const manualData = await runManualFlow();
            if (!manualData) {
                return undefined;
            }
            profileData = manualData;
        } else {
            const picked = await vscode.window.showQuickPick(
                configProfiles.map(p => ({
                    label: p.name,
                    description: `${p.username ? p.username + '@' : ''}${p.host}:${p.port || 22}`,
                    profile: p
                })),
                {
                    placeHolder: 'Select a Host configuration from your SSH config',
                    title: 'SLURM SSH: Import Profile'
                }
            );

            if (!picked) {
                return undefined; // User cancelled
            }
            profileData = picked.profile;
        }
    } else {
        const manualData = await runManualFlow();
        if (!manualData) {
            return undefined;
        }
        profileData = manualData;
    }

    if (!profileData.host) {
        return undefined;
    }

    // Step 3: Enter profile display name
    const profileName = await vscode.window.showInputBox({
        prompt: 'Enter a friendly display name for this connection profile:',
        value: profileData.name || profileData.host,
        title: 'SLURM SSH: Connection Profile Name',
        validateInput: (value) => {
            if (!value.trim()) {
                return 'Profile name is required';
            }
            return null;
        }
    });

    if (!profileName) {
        return undefined;
    }

    return {
        name: profileName.trim(),
        host: profileData.host,
        username: profileData.username,
        port: profileData.port,
        identityFile: profileData.identityFile
    };
}

/**
 * Prompts user for connection details manually
 */
async function runManualFlow(): Promise<Partial<SSHProfile> | undefined> {
    // 1. Host
    const host = await vscode.window.showInputBox({
        prompt: 'Enter remote host name or IP address:',
        placeHolder: 'e.g. cluster.university.edu',
        title: 'SLURM SSH: Host',
        validateInput: (value) => {
            if (!value.trim()) {
                return 'Host is required';
            }
            return null;
        }
    });

    if (!host) {
        return undefined;
    }

    // 2. Username
    const username = await vscode.window.showInputBox({
        prompt: 'Enter remote SSH username (optional):',
        placeHolder: 'e.g. jdoe',
        title: 'SLURM SSH: Username'
    });

    if (username === undefined) {
        return undefined;
    }

    // 3. Port
    const portStr = await vscode.window.showInputBox({
        prompt: 'Enter SSH port (optional):',
        value: '22',
        title: 'SLURM SSH: Port',
        validateInput: (value) => {
            if (value.trim()) {
                const num = parseInt(value, 10);
                if (isNaN(num) || num <= 0 || num > 65535) {
                    return 'Please enter a valid port number between 1 and 65535';
                }
            }
            return null;
        }
    });

    if (portStr === undefined) {
        return undefined;
    }

    const port = portStr.trim() ? parseInt(portStr.trim(), 10) : undefined;

    // 4. Identity File (Private key)
    const selectKeyOpt = await vscode.window.showQuickPick([
        { label: 'Use default key or SSH Agent', value: 'default' },
        { label: 'Select private key file...', value: 'pick' }
    ], {
        placeHolder: 'Configure SSH Identity (Key)',
        title: 'SLURM SSH: Authentication'
    });

    if (!selectKeyOpt) {
        return undefined;
    }

    let identityFile: string | undefined;

    if (selectKeyOpt.value === 'pick') {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: 'Select Private Key File (e.g. id_rsa, id_ed25519)',
            filters: { 'All Files': ['*'] }
        });

        if (!uris || uris.length === 0) {
            return undefined;
        }
        identityFile = uris[0].fsPath;
    }

    return {
        host: host.trim(),
        username: username.trim() || undefined,
        port,
        identityFile
    };
}

/**
 * Parses local SSH config file (~/.ssh/config) to extract Host profiles
 */
function parseSSHConfig(): SSHProfile[] {
    const profiles: SSHProfile[] = [];
    const configPath = path.join(os.homedir(), '.ssh', 'config');

    if (!fs.existsSync(configPath)) {
        return profiles;
    }

    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const lines = content.split(/\r?\n/);
        
        let currentProfile: Partial<SSHProfile> & { aliases?: string[] } | null = null;

        for (let line of lines) {
            line = line.trim();
            // Skip comments or empty lines
            if (line.startsWith('#') || !line) {
                continue;
            }

            // Split directive and arguments (splitting by whitespace)
            const parts = line.split(/\s+/);
            const directive = parts[0].toLowerCase();
            const value = parts.slice(1).join(' ');

            if (directive === 'host') {
                // If we were parsing a previous block, push it
                if (currentProfile && currentProfile.host) {
                    profiles.push(currentProfile as SSHProfile);
                }

                // Check for wildcard match (skip configurations meant for all hosts)
                if (value.includes('*') || value.includes('?')) {
                    currentProfile = null;
                    continue;
                }

                // Host can be space-separated aliases. Pick the first alias as name.
                const aliases = value.split(/\s+/).filter(Boolean);
                if (aliases.length > 0) {
                    currentProfile = {
                        name: aliases[0],
                        host: aliases[0], // fallback until HostName is parsed
                        aliases
                    };
                } else {
                    currentProfile = null;
                }
            } else if (currentProfile) {
                if (directive === 'hostname') {
                    currentProfile.host = value;
                } else if (directive === 'user') {
                    currentProfile.username = value;
                } else if (directive === 'port') {
                    currentProfile.port = parseInt(value, 10) || undefined;
                } else if (directive === 'identityfile') {
                    // Resolve home dir (~/) path in SSH identity file values
                    let idPath = value.replace(/^["']|["']$/g, ''); // strip outer quotes
                    if (idPath.startsWith('~/')) {
                        idPath = path.join(os.homedir(), idPath.substring(2));
                    }
                    currentProfile.identityFile = idPath;
                }
            }
        }

        // Push final profile
        if (currentProfile && currentProfile.host) {
            profiles.push(currentProfile as SSHProfile);
        }
    } catch (err) {
        console.error('Failed to parse ~/.ssh/config:', err);
    }

    return profiles;
}
