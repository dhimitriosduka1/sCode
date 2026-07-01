import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface SSHProfile {
    name: string;
    host: string;
    username?: string;
    port?: number;
    identityFile?: string;
}

interface PendingCommand {
    id: string;
    resolve: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    reject: (err: Error) => void;
}

/**
 * Manages a persistent interactive SSH session to tunnel commands.
 * Spawns a single `ssh` process and uses standard I/O streams with delimiters
 * to separate command outputs, eliminating the overhead of establishing
 * a new TCP/SSH handshake for every command.
 */
export class SSHSession extends EventEmitter {
    private process: ChildProcess | undefined;
    private pendingCommands = new Map<string, PendingCommand>();
    private commandCounter = 0;
    private stdoutBuffer = '';
    private stderrBuffer = '';
    private connectionTimeout: NodeJS.Timeout | undefined;

    public remoteUsername: string = '';
    public remoteHomeDir: string = '';

    constructor() {
        super();
    }

    /**
     * Connects to the remote host using SSH
     */
    async connect(profile: SSHProfile): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.disconnect();

            // -o BatchMode=yes: fail immediately if auth requires user interaction (passwords, key passphrases)
            const args: string[] = [
                '-T',
                '-o', 'ServerAliveInterval=15',
                '-o', 'ServerAliveCountMax=3',
                '-o', 'StrictHostKeyChecking=accept-new',
                '-o', 'BatchMode=yes',
                '-o', 'ControlMaster=auto',
                '-o', 'ControlPath=~/.ssh/slurm_control_%r@%h:%p',
                '-o', 'ControlPersist=4h',
            ];

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
            args.push('/bin/bash'); // Explicit shell for marker consistency

            try {
                this.process = spawn('ssh', args);
            } catch (err) {
                return reject(err);
            }

            this.process.stdout?.setEncoding('utf8');
            this.process.stderr?.setEncoding('utf8');

            let connected = false;

            // Connection timeout (10 seconds)
            this.connectionTimeout = setTimeout(() => {
                if (!connected) {
                    const extraInfo = this.stderrBuffer.trim() 
                        ? `\nSSH Stderr: ${this.stderrBuffer.trim()}`
                        : '\nMake sure your SSH key is loaded into your SSH Agent, or configure passwordless key authentication.';
                    this.disconnect();
                    reject(new Error(`SSH connection timed out after 10 seconds.${extraInfo}`));
                }
            }, 10000);

            // Listen for stdout data to parse command markers
            this.process.stdout?.on('data', (chunk: string) => {
                this.stdoutBuffer += chunk;
                this.processBuffer();
            });

            // Listen for stderr data during startup (and log to helper buffer)
            this.process.stderr?.on('data', (chunk: string) => {
                this.stderrBuffer += chunk;
            });

            // Handle process exit
            this.process.on('exit', (code) => {
                this.process = undefined;
                this.stdoutBuffer = '';
                
                const err = new Error(
                    `SSH process exited unexpectedly with code ${code}. Stderr: ${this.stderrBuffer.trim()}`
                );
                
                if (!connected) {
                    clearTimeout(this.connectionTimeout);
                    reject(err);
                } else {
                    this.emit('disconnected');
                    // Reject all pending commands
                    for (const [, pending] of this.pendingCommands) {
                        pending.reject(err);
                    }
                    this.pendingCommands.clear();
                }
            });

            this.process.on('error', (err) => {
                if (!connected) {
                    clearTimeout(this.connectionTimeout);
                    reject(err);
                } else {
                    this.emit('error', err);
                }
            });

            // Establish redirection descriptor and fetch remote username and home directory
            const checkConnection = async () => {
                try {
                    // Redirect fd 3 to stdout for commands
                    this.process!.stdin!.write('exec 3>&1\n');

                    const whoamiRes = await this.execute('whoami');
                    this.remoteUsername = whoamiRes.stdout.trim();

                    const homeRes = await this.execute('echo $HOME');
                    this.remoteHomeDir = homeRes.stdout.trim();

                    connected = true;
                    clearTimeout(this.connectionTimeout);
                    resolve();
                } catch (err) {
                    clearTimeout(this.connectionTimeout);
                    this.disconnect();
                    reject(err);
                }
            };

            // Start connection checks
            checkConnection();
        });
    }

    /**
     * Checks if the SSH session is currently connected
     */
    isConnected(): boolean {
        return this.process !== undefined && this.process.exitCode === null;
    }

    /**
     * Executes a single command on the remote host
     */
    async execute(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        if (!this.process || !this.process.stdin) {
            throw new Error('SSH session is not connected');
        }

        const id = `cmd_${++this.commandCounter}_${Date.now()}`;
        
        return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
            this.pendingCommands.set(id, {
                id,
                resolve,
                reject,
            });

            // Redirection protocol:
            // 1. Prints START marker to stdout
            // 2. Runs the command inside a subshell.
            //    - Stdout is redirected to fd 3 (the actual outer stdout).
            //    - Stderr is redirected to fd 1 (subshell stdout) and captured in __slurm_stderr__.
            // 3. Captures exit code
            // 4. Prints END marker containing the exit code
            // 5. Prints the captured stderr content
            // 6. Prints the ERR_END marker
            const payload = [
                `echo "__SLURM_CMD_START_${id}__"`,
                `__slurm_stderr__=$({ ${command}; } 2>&1 >&3)`,
                `__slurm_exit_code__=$?`,
                `echo "__SLURM_CMD_END_${id}_\${__slurm_exit_code__}__"`,
                `echo "\${__slurm_stderr__}"`,
                `echo "__SLURM_CMD_ERR_END_${id}__"`,
                ''
            ].join('\n');

            this.process!.stdin!.write(payload);
        });
    }

    /**
     * Executes multiple commands in a single batch (one round-trip)
     */
    async batchExecute(commands: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }[]> {
        if (commands.length === 0) {
            return [];
        }
        return Promise.all(commands.map(cmd => this.execute(cmd)));
    }

    /**
     * Gracefully disconnects from the remote host
     */
    async disconnect(): Promise<void> {
        clearTimeout(this.connectionTimeout);
        if (this.process) {
            try {
                this.process.stdin?.write('exit\n');
                this.process.kill();
            } catch {
                // Ignore kill errors
            }
            this.process = undefined;
        }
        this.pendingCommands.clear();
        this.stdoutBuffer = '';
        this.stderrBuffer = '';
    }

    /**
     * Helper to listen to disconnected events
     */
    onDisconnected(listener: () => void): void {
        this.on('disconnected', listener);
    }

    /**
     * Clean up resources
     */
    dispose(): void {
        this.disconnect();
    }

    /**
     * Parses stdout buffer for command delimiters and resolves pending commands
     */
    private processBuffer(): void {
        let hasChanges = true;

        while (hasChanges) {
            hasChanges = false;
            
            // Search for start marker: __SLURM_CMD_START_(id)__
            const startMatch = this.stdoutBuffer.match(/__SLURM_CMD_START_([a-zA-Z0-9_-]+)__\r?\n/);
            if (!startMatch) {
                break;
            }

            const id = startMatch[1];
            const startIndex = startMatch.index!;
            const startLength = startMatch[0].length;

            // Search for corresponding end marker: __SLURM_CMD_END_(id)_(exitCode)__
            const endPattern = new RegExp(`__SLURM_CMD_END_${id}_(\\d+)__\\r?\\n`);
            const endMatch = this.stdoutBuffer.match(endPattern);

            // Search for corresponding stderr end marker: __SLURM_CMD_ERR_END_(id)__
            const errEndPattern = new RegExp(`__SLURM_CMD_ERR_END_${id}__\\r?\\n`);
            const errEndMatch = this.stdoutBuffer.match(errEndPattern);

            if (endMatch && errEndMatch) {
                const exitCode = parseInt(endMatch[1], 10);
                const endIndex = endMatch.index!;
                const endLength = endMatch[0].length;

                const errEndIndex = errEndMatch.index!;
                const errEndLength = errEndMatch[0].length;

                // Extract stdout and stderr parts
                const stdout = this.stdoutBuffer.substring(startIndex + startLength, endIndex);
                const stderr = this.stdoutBuffer.substring(endIndex + endLength, errEndIndex);

                const pending = this.pendingCommands.get(id);
                if (pending) {
                    pending.resolve({
                        stdout,
                        stderr: stderr.trim(),
                        exitCode,
                    });
                    this.pendingCommands.delete(id);
                }

                // Slice processed part from buffer
                this.stdoutBuffer = this.stdoutBuffer.substring(errEndIndex + errEndLength);
                hasChanges = true;
            }
        }
    }
}
