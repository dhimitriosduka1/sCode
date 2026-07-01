import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SSHSession, SSHProfile } from './sshSession';
import { SlurmCommandRunner } from './slurmService';
import { createSSHCommandRunner, createLocalCommandRunner } from './sshCommandRunner';

const execAsync = promisify(exec);

export type ConnectionMode = 'local' | 'ssh' | 'disconnected';

export { SSHProfile };

/**
 * Manages the connection mode (local Slurm, SSH remote, or disconnected) and SSH profiles.
 */
export class ConnectionManager implements vscode.Disposable {
    private _mode: ConnectionMode = 'disconnected';
    private _sshSession: SSHSession | undefined;
    private _activeProfile: SSHProfile | undefined;
    private _onDidChangeConnection = new vscode.EventEmitter<ConnectionMode>();
    readonly onDidChangeConnection = this._onDidChangeConnection.event;
    
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 3;
    private reconnectTimeout: NodeJS.Timeout | undefined;
    private intentionalDisconnect = false;

    constructor(private context: vscode.ExtensionContext) {}

    get mode(): ConnectionMode {
        return this._mode;
    }

    get sshSession(): SSHSession | undefined {
        return this._sshSession;
    }

    get activeProfile(): SSHProfile | undefined {
        return this._activeProfile;
    }

    /**
     * Gets a user-friendly label describing the current connection state.
     */
    get connectionLabel(): string {
        if (this._mode === 'local') {
            return 'Local';
        }
        if (this._mode === 'ssh' && this._activeProfile) {
            return this._activeProfile.name;
        }
        return 'Disconnected';
    }

    /**
     * Check if SLURM is available locally, then try auto-connecting to the active remote profile.
     */
    async initialize(): Promise<void> {
        try {
            // First check if SLURM is available on the local machine
            await execAsync('which squeue');
            this._mode = 'local';
            this._onDidChangeConnection.fire('local');
            return;
        } catch {
            // Local squeue not found, look for SSH remote profiles
        }

        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        const autoConnect = config.get<boolean>('autoConnect', true);
        const activeProfileName = config.get<string>('activeProfile', '');

        if (autoConnect && activeProfileName) {
            const profiles = this.getProfiles();
            const profile = profiles.find(p => p.name === activeProfileName);
            if (profile) {
                try {
                    await this.connect(profile);
                } catch (err) {
                    console.error(`Auto-connect to ${activeProfileName} failed:`, err);
                    this._mode = 'disconnected';
                    this._onDidChangeConnection.fire('disconnected');
                }
            }
        }
    }

    /**
     * Connects to a remote SLURM cluster over SSH using the specified profile.
     */
    async connect(profile: SSHProfile): Promise<void> {
        this.intentionalDisconnect = false;
        this.reconnectAttempts = 0;
        clearTimeout(this.reconnectTimeout);

        const session = new SSHSession();
        await session.connect(profile);

        // Verify remote has squeue (Slurm command availability check)
        try {
            await session.execute('which squeue');
        } catch (err) {
            await session.disconnect();
            throw new Error(`Connected to host, but SLURM commands ('squeue') are not available on remote system: ${err}`);
        }

        this._sshSession = session;
        this._activeProfile = profile;
        this._mode = 'ssh';

        // Monitor disconnects
        this._sshSession.onDisconnected(() => {
            this.handleUnexpectedDisconnect();
        });

        // Save active profile name to settings
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        await config.update('activeProfile', profile.name, vscode.ConfigurationTarget.Global);

        this._onDidChangeConnection.fire('ssh');
    }

    /**
     * Disconnects from the current SSH session
     */
    async disconnect(): Promise<void> {
        this.intentionalDisconnect = true;
        clearTimeout(this.reconnectTimeout);
        this.reconnectAttempts = 0;

        if (this._sshSession) {
            await this._sshSession.disconnect();
            this._sshSession = undefined;
        }
        
        this._activeProfile = undefined;
        this._mode = 'disconnected';
        this._onDidChangeConnection.fire('disconnected');

        // Clear active profile settings
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        await config.update('activeProfile', '', vscode.ConfigurationTarget.Global);
    }

    /**
     * Switch to local SLURM mode explicitly
     */
    async useLocal(): Promise<void> {
        await this.disconnect();
        this._mode = 'local';
        this._onDidChangeConnection.fire('local');
    }

    /**
     * Returns the appropriate SlurmCommandRunner for the current mode
     */
    getCommandRunner(): SlurmCommandRunner {
        if (this._mode === 'local') {
            return createLocalCommandRunner();
        }
        if (this._mode === 'ssh' && this._sshSession) {
            return createSSHCommandRunner(this._sshSession);
        }

        // Return a runner that throws error if disconnected
        return async () => {
            throw new Error('No active SLURM cluster connection');
        };
    }

    /**
     * Gets all configured SSH profiles from settings
     */
    getProfiles(): SSHProfile[] {
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        return config.get<SSHProfile[]>('sshProfiles', []);
    }

    /**
     * Saves a new or updated SSH profile to settings
     */
    async saveProfile(profile: SSHProfile): Promise<void> {
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        const profiles = this.getProfiles();
        
        const index = profiles.findIndex(p => p.name === profile.name);
        if (index >= 0) {
            profiles[index] = profile;
        } else {
            profiles.push(profile);
        }

        await config.update('sshProfiles', profiles, vscode.ConfigurationTarget.Global);
    }

    /**
     * Deletes an SSH profile from settings
     */
    async deleteProfile(name: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('slurmClusterManager');
        const profiles = this.getProfiles();
        
        const filtered = profiles.filter(p => p.name !== name);
        await config.update('sshProfiles', filtered, vscode.ConfigurationTarget.Global);

        // If active profile is deleted, disconnect
        if (this._activeProfile?.name === name) {
            await this.disconnect();
        }
    }

    /**
     * Handle unexpected session disconnect with exponential backoff reconnect attempts
     */
    private handleUnexpectedDisconnect(): void {
        if (this.intentionalDisconnect) {
            return;
        }

        this._sshSession = undefined;
        this._mode = 'disconnected';
        this._onDidChangeConnection.fire('disconnected');

        if (this.reconnectAttempts < this.maxReconnectAttempts && this._activeProfile) {
            this.reconnectAttempts++;
            const delay = Math.pow(2, this.reconnectAttempts) * 1000;
            
            vscode.window.setStatusBarMessage(
                `$(warning) SLURM connection lost. Reconnecting in ${delay / 1000}s (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
                delay
            );

            this.reconnectTimeout = setTimeout(async () => {
                if (this._activeProfile) {
                    try {
                        await this.connect(this._activeProfile);
                        vscode.window.showInformationMessage('SLURM connection re-established.');
                    } catch {
                        this.handleUnexpectedDisconnect();
                    }
                }
            }, delay);
        } else {
            vscode.window.showErrorMessage('SLURM connection lost. Max reconnect attempts exceeded.');
        }
    }

    dispose(): void {
        clearTimeout(this.reconnectTimeout);
        this.disconnect();
        this._onDidChangeConnection.dispose();
    }
}
