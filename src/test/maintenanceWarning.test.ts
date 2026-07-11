import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { MaintenanceWindow, parseMaintenanceReservationOutput } from '../slurmService';
import {
    formatMaintenanceWarningLabel,
    formatMaintenanceWarningTooltip,
    getMostRelevantMaintenanceWindow,
} from '../maintenanceWarning';

function reservationBlock(overrides: {
    name?: string;
    flags?: string;
    nodes?: string;
    startTime?: string;
    endTime?: string;
} = {}): string {
    const name = overrides.name ?? 'maint_2026_07';
    const flags = overrides.flags ?? 'MAINT,IGNORE_JOBS';
    const nodes = overrides.nodes ?? 'node[001-050]';
    const startTime = overrides.startTime ?? '2026-08-01T02:00:00';
    const endTime = overrides.endTime ?? '2026-08-01T08:00:00';

    return [
        `ReservationName=${name} StartTime=${startTime} EndTime=${endTime} Duration=06:00:00`,
        `   Nodes=${nodes} NodeCnt=50 CoreCnt=6400 Features=(null) PartitionName=(null) Flags=${flags}`,
        `   TRES=cpu=6400`,
        `   Users=(null) Groups=(null) Accounts=(null) Licenses=(null) State=INACTIVE BurstBuffer=(null) Watts=n/a`,
        `   MaxStartDelay=(null)`,
        '',
    ].join('\n');
}

describe('parseMaintenanceReservationOutput', () => {
    it('parses a MAINT-flagged reservation into a maintenance window', () => {
        const windows = parseMaintenanceReservationOutput(reservationBlock());

        assert.deepEqual(windows, [
            {
                name: 'maint_2026_07',
                nodes: 'node[001-050]',
                startTime: '2026-08-01T02:00:00',
                endTime: '2026-08-01T08:00:00',
            },
        ]);
    });

    it('ignores reservations without the MAINT flag', () => {
        const stdout = reservationBlock({ name: 'user_reservation', flags: 'IGNORE_JOBS' });
        assert.deepEqual(parseMaintenanceReservationOutput(stdout), []);
    });

    it('parses multiple reservations, keeping only MAINT ones', () => {
        const stdout = [
            reservationBlock({ name: 'maint_a' }),
            reservationBlock({ name: 'user_res', flags: 'ANY_NODES' }),
            reservationBlock({ name: 'maint_b', startTime: '2026-09-01T00:00:00', endTime: '2026-09-01T04:00:00' }),
        ].join('\n');

        const windows = parseMaintenanceReservationOutput(stdout);
        assert.deepEqual(windows.map(w => w.name), ['maint_a', 'maint_b']);
    });

    it('returns an empty array when there are no reservations', () => {
        assert.deepEqual(parseMaintenanceReservationOutput('No reservations in the system\n'), []);
    });
});

describe('getMostRelevantMaintenanceWindow', () => {
    const now = new Date('2026-07-11T12:00:00Z');

    it('returns undefined when there are no windows', () => {
        assert.equal(getMostRelevantMaintenanceWindow([], now), undefined);
    });

    it('ignores windows that have already ended', () => {
        const past: MaintenanceWindow = {
            name: 'past_maint',
            nodes: 'ALL',
            startTime: '2026-07-01T00:00:00Z',
            endTime: '2026-07-02T00:00:00Z',
        };
        assert.equal(getMostRelevantMaintenanceWindow([past], now), undefined);
    });

    it('marks a window as active when now falls within its start/end range', () => {
        const active: MaintenanceWindow = {
            name: 'active_maint',
            nodes: 'ALL',
            startTime: '2026-07-11T10:00:00Z',
            endTime: '2026-07-11T14:00:00Z',
        };
        const status = getMostRelevantMaintenanceWindow([active], now);
        assert.equal(status?.isActive, true);
        assert.equal(status?.window.name, 'active_maint');
    });

    it('picks the soonest upcoming window when multiple are pending', () => {
        const later: MaintenanceWindow = {
            name: 'later_maint',
            nodes: 'ALL',
            startTime: '2026-08-01T00:00:00Z',
            endTime: '2026-08-01T04:00:00Z',
        };
        const sooner: MaintenanceWindow = {
            name: 'sooner_maint',
            nodes: 'ALL',
            startTime: '2026-07-12T00:00:00Z',
            endTime: '2026-07-12T04:00:00Z',
        };
        const status = getMostRelevantMaintenanceWindow([later, sooner], now);
        assert.equal(status?.window.name, 'sooner_maint');
        assert.equal(status?.isActive, false);
    });
});

describe('formatMaintenanceWarningLabel', () => {
    const now = new Date('2026-07-11T12:00:00Z');

    it('labels an active window as in progress', () => {
        const label = formatMaintenanceWarningLabel({
            window: { name: 'm', nodes: 'ALL', startTime: '2026-07-11T10:00:00Z', endTime: '2026-07-11T14:00:00Z' },
            isActive: true,
        }, now);
        assert.equal(label, 'Cluster maintenance in progress');
    });

    it('labels an upcoming window with a relative countdown', () => {
        const label = formatMaintenanceWarningLabel({
            window: { name: 'm', nodes: 'ALL', startTime: '2026-07-13T12:00:00Z', endTime: '2026-07-13T18:00:00Z' },
            isActive: false,
        }, now);
        assert.equal(label, 'Cluster maintenance starts in 2d');
    });
});

describe('formatMaintenanceWarningTooltip', () => {
    it('includes the reservation name, nodes, and start/end times', () => {
        const markdown = formatMaintenanceWarningTooltip({
            window: { name: 'maint_2026_08', nodes: 'node[001-050]', startTime: '2026-08-01T02:00:00', endTime: '2026-08-01T08:00:00' },
            isActive: false,
        });

        assert.match(markdown, /Cluster Maintenance/);
        assert.match(markdown, /maint_2026_08/);
        assert.match(markdown, /node\[001-050\]/);
    });
});
