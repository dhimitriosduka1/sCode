import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { getPendingReasonInfo } from '../slurmService';

describe('getPendingReasonInfo', () => {
    it('returns undefined for empty or missing reasons', () => {
        assert.equal(getPendingReasonInfo(undefined), undefined);
        assert.equal(getPendingReasonInfo(''), undefined);
        assert.equal(getPendingReasonInfo('   '), undefined);
        assert.equal(getPendingReasonInfo('N/A'), undefined);
        assert.equal(getPendingReasonInfo('(null)'), undefined);
    });

    it('formats common resource and priority reasons', () => {
        assert.deepEqual(getPendingReasonInfo('Resources'), {
            code: 'Resources',
            label: 'Waiting for resources',
            description: 'The requested CPUs, memory, GPUs, nodes, or other resources are not available right now.',
        });

        assert.deepEqual(getPendingReasonInfo('(Priority)'), {
            code: 'Priority',
            label: 'Waiting on priority',
            description: 'Higher-priority jobs are ahead of this job in the queue.',
        });
    });

    it('formats dependency reasons', () => {
        assert.deepEqual(getPendingReasonInfo('Dependency'), {
            code: 'Dependency',
            label: 'Waiting on dependency',
            description: 'The job depends on another job that has not completed successfully yet.',
        });

        assert.deepEqual(getPendingReasonInfo('DependencyNeverSatisfied'), {
            code: 'DependencyNeverSatisfied',
            label: 'Dependency will not complete',
            description: 'The job has a dependency that Slurm believes can never be satisfied.',
        });
    });

    it('keeps Slurm detail text attached to known reason codes', () => {
        assert.deepEqual(getPendingReasonInfo('ReqNodeNotAvail, UnavailableNodes:node001'), {
            code: 'ReqNodeNotAvail',
            label: 'Requested node unavailable',
            description: 'A specifically requested node is unavailable, reserved, down, drained, or not responding. Details: UnavailableNodes:node001.',
        });
    });

    it('uses generic explanations for reason-code families', () => {
        assert.deepEqual(getPendingReasonInfo('QOSMaxJobsPerUserLimit'), {
            code: 'QOSMaxJobsPerUserLimit',
            label: 'QOS max limit',
            description: 'The job request exceeds a maximum limit for the selected quality of service.',
        });

        assert.deepEqual(getPendingReasonInfo('AssocGrpSubmitJobsLimit'), {
            code: 'AssocGrpSubmitJobsLimit',
            label: 'Association group limit',
            description: 'The association has reached an aggregate limit for jobs, time, or resources.',
        });

        assert.deepEqual(getPendingReasonInfo('MaxJobsPerAccount'), {
            code: 'MaxJobsPerAccount',
            label: 'Account QOS limit',
            description: 'The job request exceeds a per-account limit on the selected quality of service.',
        });
    });

    it('falls back to readable text for unknown CamelCase codes', () => {
        assert.deepEqual(getPendingReasonInfo('SiteSpecificHoldReason'), {
            code: 'SiteSpecificHoldReason',
            label: 'Site Specific Hold Reason',
            description: 'Slurm reported: Site Specific Hold Reason.',
        });
    });
});
