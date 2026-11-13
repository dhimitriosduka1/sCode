import { after, afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A stand-in for ssh, first on PATH before sshConnection loads, since that
// copies the environment once. What it does is read from files next to it:
// `mode` for how signing in goes, `master` for the pid of a running master.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'scode-fake-ssh-'));
fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
dir=$(dirname "$0")
if [ "$1" = "-O" ]; then
    if [ -f "$dir/master" ]; then echo "Master running (pid=$(cat "$dir/master"))" >&2; exit 0; fi
    echo "Control socket connect: No such file or directory" >&2; exit 255
fi
case "$(cat "$dir/mode")" in
    # Signs in, hands the socket to a master it forks (ControlPersist), and returns
    detach) echo 4242 > "$dir/master"; exit 0 ;;
    # Returns as if it had, but nothing answers on the socket
    vanish) exit 0 ;;
    denied) echo "user@raven: Permission denied (publickey,keyboard-interactive)." >&2; exit 255 ;;
    # Another master holds the socket: ssh stays connected without multiplexing
    taken) echo "ControlSocket /tmp/x already exists, disabling multiplexing" >&2; exec sleep 30 ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const { startMasterInBackground } = require('../sshConnection') as typeof import('../sshConnection');

const TARGET = { alias: 'raven', socketPath: path.join(bin, 'socket') };

function setUp(mode: string, runningMasterPid?: number): void {
    fs.writeFileSync(path.join(bin, 'mode'), mode);
    if (runningMasterPid !== undefined) {
        fs.writeFileSync(path.join(bin, 'master'), String(runningMasterPid));
    }
}

describe('startMasterInBackground', () => {
    afterEach(() => fs.rmSync(path.join(bin, 'master'), { force: true }));
    after(() => fs.rmSync(bin, { recursive: true, force: true }));

    it('has started the master once ssh signs in, forks it and returns', async () => {
        setUp('detach');
        assert.deepEqual(await startMasterInBackground(TARGET), { status: 'started' });
    });

    it('fails when ssh returns but no master answers', async () => {
        setUp('vanish');
        assert.equal((await startMasterInBackground(TARGET)).status, 'failed');
    });

    it('fails with what ssh said when it cannot sign in without a prompt', async () => {
        setUp('denied');
        const result = await startMasterInBackground(TARGET);
        assert.equal(result.status, 'failed');
        assert.match(result.status === 'failed' ? result.stderr : '', /Permission denied/);
    });

    // Another window took the socket first: ours would sit there signed in with
    // nothing able to reach it, so it is stopped and theirs is used
    it('stops its ssh and shares the master that holds the socket', async () => {
        setUp('taken', 7777);
        const startedAt = Date.now();
        assert.deepEqual(await startMasterInBackground(TARGET), { status: 'shared' });
        assert.ok(Date.now() - startedAt < 10_000, 'did not wait for ssh to give up');
    });
});
