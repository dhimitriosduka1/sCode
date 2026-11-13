import * as fs from 'fs';
import * as vscode from 'vscode';
import { SshConfigHost } from './sshConfigHosts';
import { getCurrentUsername, getLocalAccount, localCommandRunner, SlurmAccount, SlurmCommandRunner } from './slurmService';
import {
    buildMasterArgs,
    checkSharedFolder,
    createSshCommandRunner,
    ensurePrivateSocketDir,
    getSocketPath,
    isMasterRunning,
    MASTER_KEEPALIVE_MS,
    readRemoteFileTail,
    RemoteFileStat,
    removeStaleSocket,
    resolveSshUser,
    SharedFolderCheck,
    statRemoteFile,
    statRemoteFiles,
    SSH_FAILURE_EXIT_CODE,
    SshTarget,
    startMasterInBackground,
    stopMaster,
} from './sshConnection';

export type ClusterConnectionState =
    /** Commands run on this machine. `notice` says why, after a connection ended or failed. */
    | { kind: 'local'; notice?: string }
    | { kind: 'connecting'; host: SshConfigHost }
    | { kind: 'connected'; host: SshConfigHost };

// Failures a terminal sign-in cannot get past, so none is offered
const NETWORK_FAILURE_PATTERN = /Could not resolve hostname|Connection timed out|Operation timed out|Connection refused|No route to host|Network is unreachable/i;

const SIGN_IN_POLL_MS = 750;
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** The host this workspace was last connected to, to reconnect to when the window comes back. */
const CONNECTED_HOST_KEY = 'slurmClusterManager.connectedHost';

/**
 * Where Slurm commands run: on this machine, or on a cluster over SSH. Every
 * command goes through `run`, which follows the current connection.
 */
export class ClusterConnection implements vscode.Disposable {
    private state: ClusterConnectionState = { kind: 'local' };
    private target?: SshTarget;
    private sshRunner?: SlurmCommandRunner;
    /** The account ssh logs in to the connected host as. */
    private username?: string;
    /** That account's home folder on the host, for `~` in paths. */
    private homeDir?: string;
    /**
     * Bumped whenever a connection attempt is superseded (another host picked,
     * cancelled, disconnected, window closing), so the attempt can tell it should
     * stop and undo whatever it started.
     */
    private attempt = 0;
    private signInTerminal?: vscode.Terminal;
    private dropCheck?: { target: SshTarget; promise: Promise<void> };
    private keepAlive?: ReturnType<typeof setInterval>;
    private readonly changeEmitter = new vscode.EventEmitter<ClusterConnectionState>();
    readonly onDidChange = this.changeEmitter.event;

    /** @param memory Where the connected host is remembered, per workspace */
    constructor(private readonly memory: vscode.Memento) {}

    /** The host this workspace was connected to when its window last closed or reloaded. */
    getRememberedHost(): string | undefined {
        return this.memory.get<string>(CONNECTED_HOST_KEY);
    }

    getState(): ClusterConnectionState {
        return this.state;
    }

    /** Who the user is wherever commands run, with the host when that is a cluster. */
    getAccount(): SlurmAccount {
        if (this.state.kind !== 'connected') {
            return getLocalAccount();
        }
        // The account ssh logs in as there
        return { username: this.username || getCurrentUsername(), homeDir: this.homeDir, cluster: this.state.host.alias };
    }

    /** Stats a file on the connected host; throws when not connected to `alias`. */
    statFile(alias: string, filePath: string): Promise<RemoteFileStat> {
        return this.withConnection(alias, (target) => statRemoteFile(target, filePath));
    }

    /** Stats several files on the connected host in one round trip; unreadable ones come back undefined. */
    statFiles(alias: string, filePaths: string[]): Promise<(RemoteFileStat | undefined)[]> {
        return this.withConnection(alias, (target) => statRemoteFiles(target, filePaths));
    }

    /** Reads up to the last `maxBytes` of a file on the connected host. */
    readFileTail(alias: string, filePath: string, maxBytes: number): Promise<Buffer> {
        return this.withConnection(alias, (target) => readRemoteFileTail(target, filePath, maxBytes));
    }

    /** Runs `action` over the connection to `alias`, noticing if the connection has gone. */
    private async withConnection<T>(alias: string, action: (target: SshTarget) => Promise<T>): Promise<T> {
        const target = this.target;
        if (!target || this.state.kind !== 'connected' || target.alias.toLowerCase() !== alias.toLowerCase()) {
            throw new NotConnectedError(alias);
        }
        if (!fs.existsSync(target.socketPath)) {
            this.checkForDrop(target);
            throw new NotConnectedError(alias);
        }
        try {
            return await action(target);
        } catch (error) {
            if ((error as { code?: unknown }).code === SSH_FAILURE_EXIT_CODE) {
                this.checkForDrop(target);
            }
            throw error;
        }
    }

    readonly run: SlurmCommandRunner = async (command, options) => {
        const target = this.target;
        const sshRunner = this.state.kind === 'connected' ? this.sshRunner : undefined;
        if (!target || !sshRunner) {
            return localCommandRunner(command, options);
        }

        // A master that exited takes its socket with it, and ssh would then sign in
        // afresh for every command; that is a lost connection, not something to hide
        if (!fs.existsSync(target.socketPath)) {
            this.checkForDrop(target);
            throw Object.assign(new Error(`Not connected to ${target.alias}`), { code: SSH_FAILURE_EXIT_CODE });
        }

        try {
            return await sshRunner(command, options);
        } catch (error) {
            // ssh's own failure, not the command's: the connection may be gone
            if ((error as { code?: unknown }).code === SSH_FAILURE_EXIT_CODE) {
                this.checkForDrop(target);
            }
            throw error;
        }
    };

    /**
     * Signs in to the host and switches commands over to it, replacing any
     * connection or attempt before it. Uses a master that is still open (from
     * another window, or this one before it reloaded), then tries signing in
     * without prompts, and only then opens a terminal for the user to sign in to
     * OpenSSH themselves. Without `interactive`, as when reconnecting by itself,
     * it stops short of the terminal and says the host needs signing in to.
     */
    async connect(host: SshConfigHost, { interactive = true }: { interactive?: boolean } = {}): Promise<void> {
        // A second click on the host already signing in changes nothing
        if (this.state.kind === 'connecting' && this.state.host.alias === host.alias) {
            return;
        }
        await this.endCurrent();
        const attempt = this.attempt;
        const superseded = () => attempt !== this.attempt;

        let target: SshTarget;
        try {
            target = { alias: host.alias, socketPath: getSocketPath(host.alias, ensurePrivateSocketDir()) };
        } catch (error) {
            this.setState({ kind: 'local', notice: `Could not connect to ${host.alias}: ${(error as Error).message}` });
            return;
        }

        this.setState({ kind: 'connecting', host });
        // Signed in already, e.g. by another window: nothing to start, and not ours to close
        let ownsMaster = false;
        if (!(await isMasterRunning(target))) {
            if (superseded()) {
                return;
            }
            await removeStaleSocket(target);
            const background = await startMasterInBackground(target, { isCancelled: superseded });
            if (background.status === 'started') {
                ownsMaster = true;
            } else if (background.status === 'failed') {
                if (superseded()) {
                    return;
                }
                if (NETWORK_FAILURE_PATTERN.test(background.stderr)) {
                    this.setState({ kind: 'local', notice: `Could not connect to ${host.alias}: ${describeSshError(background.stderr)}` });
                    return;
                }
                if (!interactive) {
                    this.setState({ kind: 'local', notice: `Reconnecting to ${host.alias} needs you to sign in.` });
                    return;
                }
                const signedIn = await this.signInInTerminal(target, superseded);
                // Cancelled just as ssh signed in and forked: it would be left with nobody to close it
                if (superseded()) {
                    await this.stopAbandonedMaster(target);
                    return;
                }
                if (!signedIn) {
                    this.setState({ kind: 'local', notice: `Did not connect to ${host.alias}.` });
                    return;
                }
                ownsMaster = true;
            }
        }

        // Fair share and Hall of Shame look the user up by this name, and `~` in log
        // paths is their home there, so both are known before anything renders
        const [username, homeDir] = await Promise.all([
            resolveSshUser(target.alias).then((user) => user ?? host.user),
            readRemoteHome(target),
        ]);
        // Only computers that share the cluster's file system at the same paths are
        // supported, so that logs, scripts and working folders are the same files here
        const shared: SharedFolderCheck = homeDir
            ? await checkSharedFolder(target, homeDir)
            : { shared: false, reason: `${host.alias} did not say where your home folder is` };
        if (superseded()) {
            if (ownsMaster) {
                await this.stopAbandonedMaster(target);
            }
            return;
        }
        if (!shared.shared) {
            if (ownsMaster) {
                await stopMaster(target);
            }
            void this.memory.update(CONNECTED_HOST_KEY, undefined);
            this.setState({
                kind: 'local',
                notice: `Did not connect to ${host.alias}: this computer does not share its file system (${shared.reason}). `
                    + 'Connecting over SSH works only from computers that mount the cluster\'s file systems at the same paths.',
            });
            return;
        }
        this.target = target;
        this.username = username;
        this.homeDir = homeDir;
        this.sshRunner = createSshCommandRunner(target);
        // An open window keeps the master in use, so it never closes itself under it
        this.keepAlive = setInterval(() => void this.run('true').catch(() => undefined), MASTER_KEEPALIVE_MS);
        // Not waited for: nothing may come between the superseded check above and
        // the new state, or an attempt the user has since left would still connect
        void this.memory.update(CONNECTED_HOST_KEY, host.alias);
        this.setState({ kind: 'connected', host });
    }

    /** Stops a master an abandoned attempt started, unless a newer attempt has taken it up. */
    private async stopAbandonedMaster(target: SshTarget): Promise<void> {
        const current = this.state;
        if (current.kind !== 'local' && current.host.alias === target.alias) {
            return;
        }
        await stopMaster(target);
    }

    /**
     * Ends the connection, or the attempt in progress. A connection is signed
     * out of entirely, which also ends it for other windows sharing it: the
     * user asked to leave the host, not just this window.
     */
    async disconnect(notice?: string): Promise<void> {
        const target = this.target;
        await this.endCurrent();
        void this.memory.update(CONNECTED_HOST_KEY, undefined);
        this.setState({ kind: 'local', notice });
        if (target) {
            await stopMaster(target);
        }
    }

    /** Whether the connection still works, ending it as lost if not. */
    async confirmConnected(): Promise<boolean> {
        const target = this.target;
        if (!target || this.state.kind !== 'connected') {
            return false;
        }
        this.checkForDrop(target);
        await this.dropCheck?.promise;
        return this.target === target && this.state.kind === 'connected';
    }

    /** Forgets why the last connection ended, once the user has moved on. */
    clearNotice(): void {
        if (this.state.kind === 'local' && this.state.notice) {
            this.state = { kind: 'local' };
        }
    }

    /**
     * For when the window closes or reloads, which it cannot tell apart: leaves
     * the master open, so a reloaded window reconnects without signing in, and
     * it closes itself once unused for MASTER_IDLE_TIMEOUT.
     */
    async shutdown(): Promise<void> {
        await this.endCurrent();
    }

    dispose(): void {
        clearInterval(this.keepAlive);
        this.changeEmitter.dispose();
    }

    /**
     * Supersedes the current attempt (which then stops any master it started)
     * and closes its terminal, and forgets the current connection without
     * signing out of it.
     */
    private async endCurrent(): Promise<void> {
        this.attempt++;
        clearInterval(this.keepAlive);
        this.keepAlive = undefined;
        this.target = undefined;
        this.sshRunner = undefined;
        this.username = undefined;
        this.homeDir = undefined;
        this.signInTerminal?.dispose();
        this.signInTerminal = undefined;
    }

    private setState(state: ClusterConnectionState): void {
        this.state = state;
        this.changeEmitter.fire(state);
    }

    private checkForDrop(target: SshTarget): void {
        if (this.dropCheck?.target === target) {
            return;
        }
        const promise = (async () => {
            const running = await isMasterRunning(target);
            if (!running && this.target === target && this.state.kind === 'connected') {
                const alias = this.state.host.alias;
                await this.endCurrent();
                await removeStaleSocket(target);
                this.setState({ kind: 'local', notice: `Lost the connection to ${alias}.` });
            }
        })().finally(() => {
            if (this.dropCheck?.promise === promise) {
                this.dropCheck = undefined;
            }
        });
        this.dropCheck = { target, promise };
    }

    /**
     * Runs the master in a terminal so that OpenSSH asks the user for whatever it
     * needs (confirming a new host key, a password, a 2FA code) without the
     * extension seeing any of it. Once signed in, ssh goes to the background, and
     * the terminal closes. Resolves false if the user closes the terminal first,
     * ssh gives up, nobody signs in for five minutes, or the attempt is
     * superseded. A terminal whose ssh failed stays open so its error can be read,
     * until the next attempt replaces it.
     */
    private signInInTerminal(target: SshTarget, superseded: () => boolean): Promise<boolean> {
        const terminal = vscode.window.createTerminal({
            name: `Sign in: ${target.alias}`,
            shellPath: 'ssh',
            shellArgs: buildMasterArgs(target, 'terminal'),
            iconPath: new vscode.ThemeIcon('remote'),
            message: `Signing in to ${target.alias} for the SLURM Cluster sidebar. This terminal closes once you are connected.`,
            // Not brought back on reload: it is only for this one sign-in
            isTransient: true,
        });
        this.signInTerminal = terminal;
        terminal.show();

        return new Promise((resolve) => {
            let settled = false;
            let pollTimer: NodeJS.Timeout | undefined;
            const startedAt = Date.now();
            const finish = (connected: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(pollTimer);
                closeListener.dispose();
                if (connected || superseded() || Date.now() - startedAt >= SIGN_IN_TIMEOUT_MS) {
                    terminal.dispose();
                    if (this.signInTerminal === terminal) {
                        this.signInTerminal = undefined;
                    }
                }
                resolve(connected && !superseded());
            };

            // Each check waits for the previous one, so slow checks never pile up
            const poll = async () => {
                if (settled) {
                    return;
                }
                if (superseded()) {
                    finish(false);
                } else if (await isMasterRunning(target)) {
                    finish(true);
                } else if (terminal.exitStatus !== undefined || Date.now() - startedAt >= SIGN_IN_TIMEOUT_MS) {
                    // ssh gave up, or nobody is signing in
                    finish(false);
                } else {
                    pollTimer = setTimeout(() => void poll(), SIGN_IN_POLL_MS);
                }
            };
            pollTimer = setTimeout(() => void poll(), SIGN_IN_POLL_MS);

            const closeListener = vscode.window.onDidCloseTerminal(async (closed) => {
                if (closed === terminal) {
                    finish(!superseded() && await isMasterRunning(target));
                }
            });
        });
    }
}

/** A file was asked for on a host the sidebar is not connected to (any more). */
export class NotConnectedError extends Error {
    constructor(readonly alias: string) {
        super(`Not connected to ${alias}`);
    }
}

/** The home folder of the account on the host, or undefined if the shell does not say. */
async function readRemoteHome(target: SshTarget): Promise<string | undefined> {
    try {
        const { stdout } = await createSshCommandRunner(target)('printf %s "$HOME"', { timeout: 15_000 });
        return stdout.startsWith('/') ? stdout.trim() : undefined;
    } catch {
        return undefined;
    }
}

/** ssh's last line of complaint, without its `ssh: ` prefix, as a sentence. */
function describeSshError(stderr: string): string {
    const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const line = (lines[lines.length - 1] ?? 'ssh failed').replace(/^ssh:\s*/, '');
    return /[.!?]$/.test(line) ? line : `${line}.`;
}
