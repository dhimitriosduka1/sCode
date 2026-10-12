import * as vscode from 'vscode';
import { localCommandRunner, SlurmCommandRunner, SlurmNotConnectedError } from './slurmCommandRunner';
import {
    ensurePrivateDirectory,
    getControlSocketPath,
    getSocketDirectory,
    SshConnection,
    validateSshHost,
} from './sshConnection';
import { CAN_CONNECT_OVER_SSH } from './unavailableItem';

const SSH_HOST_SETTING = 'sshHost';
const CONNECTED_CONTEXT_KEY = 'slurmClusterManager.sshConnected';

/** Keeps the shared connection open while VS Code is, even with every refresh turned off */
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
/** How long to wait for the user to finish logging in */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 500;
/** After ssh hands the connection to its background process and exits, how long to wait for the socket */
const LOGIN_EXIT_GRACE_POLLS = 6;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Decides where Slurm commands run: on this machine, or on the cluster over a
 * shared SSH connection when `slurmClusterManager.sshHost` is set.
 */
export class ClusterConnection implements vscode.Disposable {
    private ssh: SshConnection | undefined;
    private connected = false;
    private loginTerminal: vscode.Terminal | undefined;
    private loggingInTo: string | undefined;
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private readonly loginEmitter = new vscode.EventEmitter<string | undefined>();
    private readonly disposables: vscode.Disposable[] = [];

    /** Fires when commands start going somewhere else, or the connection opens or closes */
    readonly onDidChange = this.changeEmitter.event;

    /** Fires with the host being logged in to when a login starts, and undefined when it ends */
    readonly onDidChangeLogin = this.loginEmitter.event;

    constructor() {
        this.ssh = this.createSshConnection();
        void this.refreshConnectedState();

        const keepalive = setInterval(() => {
            if (this.ssh && this.connected) {
                void this.run(['true']).catch(() => undefined);
            }
        }, KEEPALIVE_INTERVAL_MS);

        this.disposables.push(
            this.changeEmitter,
            this.loginEmitter,
            { dispose: () => clearInterval(keepalive) },
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`slurmClusterManager.${SSH_HOST_SETTING}`)) {
                    this.reload();
                }
            }),
        );
    }

    /** The host commands run on over SSH, or undefined when they run on this machine */
    get host(): string | undefined {
        return this.ssh?.host;
    }

    /** Runs a command wherever Slurm commands currently go */
    readonly run: SlurmCommandRunner = async (argv, options) => {
        const ssh = this.ssh;
        if (!ssh) {
            return localCommandRunner(argv, options);
        }

        try {
            const result = await ssh.run(argv, options);
            // Another window may have logged in
            this.setConnected(true);
            return result;
        } catch (error) {
            if (error instanceof SlurmNotConnectedError) {
                this.setConnected(false);
            }
            throw error;
        }
    };

    /**
     * Logs in to the cluster: to `host` when given, which then becomes where
     * commands run, otherwise to the configured host, asking for one if none is set.
     */
    async connect(host?: string): Promise<void> {
        if (!CAN_CONNECT_OVER_SSH) {
            vscode.window.showWarningMessage('Connecting to a cluster over SSH isn\'t supported on Windows yet. Use Remote - SSH instead.');
            return;
        }

        const ready = host !== undefined
            ? await this.useHost(host)
            : this.ssh !== undefined || await this.askForHost();
        const ssh = this.ssh;
        if (!ready || !ssh || this.loggingInTo === ssh.host) {
            return;
        }

        this.setLoggingIn(ssh.host);
        try {
            await this.logIn(ssh);
        } finally {
            // Picking another host meanwhile started a login of its own
            if (this.loggingInTo === ssh.host) {
                this.setLoggingIn(undefined);
            }
        }
    }

    /** Asks for a host, which needn't be in the SSH config, and logs in to it */
    async connectToOtherHost(): Promise<void> {
        if (await this.askForHost()) {
            await this.connect();
        }
    }

    private async logIn(ssh: SshConnection): Promise<void> {
        if (await ssh.isConnected()) {
            this.setConnected(true);
            vscode.window.setStatusBarMessage(`$(check) Connected to ${ssh.host}`, 5000);
            return;
        }

        await ssh.removeStaleSocket();
        this.loginTerminal?.dispose();

        // ssh runs directly, not through a shell, and OpenSSH answers its own prompts here
        const terminal = vscode.window.createTerminal({
            name: `SLURM: ${ssh.host}`,
            shellPath: 'ssh',
            shellArgs: ssh.loginArgs(),
            iconPath: new vscode.ThemeIcon('plug'),
        });
        this.loginTerminal = terminal;
        terminal.show();

        const outcome = await this.waitForLogin(ssh, terminal);
        if (this.ssh !== ssh) {
            return;
        }

        if (outcome === 'connected') {
            terminal.dispose();
            this.setConnected(true);
            vscode.window.setStatusBarMessage(`$(check) Connected to ${ssh.host}`, 5000);
        } else if (outcome === 'failed') {
            vscode.window.showErrorMessage(`Couldn't connect to ${ssh.host}. The terminal shows what ssh reported.`);
        } else if (outcome === 'timeout') {
            vscode.window.showWarningMessage(`Still not connected to ${ssh.host}. Run Connect to Cluster again once you can log in.`);
        }
    }

    /** Closes the shared connection, for every VS Code window using it */
    async disconnect(): Promise<void> {
        if (!this.ssh) {
            return;
        }
        await this.ssh.disconnect();
        this.setConnected(false);
    }

    dispose(): void {
        // The connection isn't closed: other windows may share it, and it closes
        // by itself once no commands have run for a while
        this.loginTerminal?.dispose();
        this.disposables.forEach(disposable => disposable.dispose());
    }

    private setLoggingIn(host: string | undefined): void {
        this.loggingInTo = host;
        this.loginEmitter.fire(host);
    }

    /** Makes `host` where commands run, saving it as the setting */
    private async useHost(host: string): Promise<boolean> {
        const problem = validateSshHost(host);
        if (problem) {
            vscode.window.showErrorMessage(`Can't connect to "${host}". ${problem}.`);
            return false;
        }

        if (this.ssh?.host !== host) {
            await vscode.workspace
                .getConfiguration('slurmClusterManager')
                .update(SSH_HOST_SETTING, host, vscode.ConfigurationTarget.Global);
            this.reload();
        }
        return this.ssh?.host === host;
    }

    private async askForHost(): Promise<boolean> {
        const host = (await vscode.window.showInputBox({
            title: 'Connect to Cluster',
            prompt: 'The SSH host of your cluster\'s login node. Slurm commands will run there.',
            placeHolder: 'mycluster (a Host in ~/.ssh/config) or user@login.example.org',
            ignoreFocusOut: true,
            validateInput: value => validateSshHost(value.trim()),
        }))?.trim();

        return host ? this.useHost(host) : false;
    }

    private async waitForLogin(
        ssh: SshConnection,
        terminal: vscode.Terminal,
    ): Promise<'connected' | 'failed' | 'closed' | 'timeout'> {
        const deadline = Date.now() + LOGIN_TIMEOUT_MS;
        let pollsSinceExit = 0;

        while (Date.now() < deadline) {
            if (await ssh.isConnected()) {
                return 'connected';
            }

            const exitStatus = terminal.exitStatus;
            if (exitStatus) {
                if (exitStatus.code === undefined) {
                    return 'closed';
                }
                // A successful login exits with 0 once the connection runs in the background
                if (exitStatus.code !== 0 || ++pollsSinceExit > LOGIN_EXIT_GRACE_POLLS) {
                    return 'failed';
                }
            }

            await delay(LOGIN_POLL_INTERVAL_MS);
        }

        return 'timeout';
    }

    /** Re-reads the host setting, keeping the current connection if it's for the same host */
    private reload(): void {
        const ssh = this.createSshConnection();
        if (ssh?.host === this.ssh?.host) {
            return;
        }

        this.ssh = ssh;
        this.connected = false;
        void this.setConnectedContext();
        void this.refreshConnectedState();
        this.changeEmitter.fire();
    }

    private createSshConnection(): SshConnection | undefined {
        const host = vscode.workspace
            .getConfiguration('slurmClusterManager')
            .get<string>(SSH_HOST_SETTING, '')
            .trim();

        if (!host) {
            return undefined;
        }

        if (!CAN_CONNECT_OVER_SSH) {
            vscode.window.showWarningMessage('slurmClusterManager.sshHost is ignored: connecting over SSH isn\'t supported on Windows yet.');
            return undefined;
        }

        const problem = validateSshHost(host);
        if (problem) {
            vscode.window.showErrorMessage(`slurmClusterManager.sshHost "${host}" can't be used. ${problem}.`);
            return undefined;
        }

        try {
            const socketDirectory = getSocketDirectory();
            ensurePrivateDirectory(socketDirectory);
            return new SshConnection(host, getControlSocketPath(socketDirectory, host));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Can't connect to ${host} over SSH: ${message}`);
            return undefined;
        }
    }

    /** Picks up a connection that's already open, from another window or an earlier session */
    private async refreshConnectedState(): Promise<void> {
        const ssh = this.ssh;
        const connected = ssh ? await ssh.isConnected() : false;
        if (this.ssh === ssh) {
            this.setConnected(connected);
        }
    }

    private setConnected(connected: boolean): void {
        if (this.connected === connected) {
            return;
        }
        this.connected = connected;
        void this.setConnectedContext();
        this.changeEmitter.fire();
    }

    private setConnectedContext(): Thenable<unknown> {
        return vscode.commands.executeCommand('setContext', CONNECTED_CONTEXT_KEY, this.ssh !== undefined && this.connected);
    }
}
