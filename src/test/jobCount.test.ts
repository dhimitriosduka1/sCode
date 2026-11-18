import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countJobs } from '../jobCount';

describe('countJobs', () => {
    it('counts standalone jobs and individual array tasks once each', () => {
        assert.equal(countJobs([]), 0);
        assert.equal(countJobs(new Set(['123', '124_0', '124_12', '125+0'])), 4);
    });

    it('counts a grouped array alongside tasks that have their own rows', () => {
        assert.equal(countJobs(['123', '124_0', ' 124_[1-100%10] ']), 102);
        assert.equal(countJobs(['125[3]']), 1);
    });

    it('counts mixed lists and stepped ranges, including a step that misses the endpoint', () => {
        assert.equal(countJobs(['123_[0,2-8:3,10-14:3,20-22%2]']), 9);
        assert.equal(countJobs(['124_[0-3999999:2]']), 2_000_000);
    });

    it('counts complete task lists longer than the default Slurm output width', () => {
        const indices = Array.from({ length: 40 }, (_, index) => index * index);
        assert.equal(countJobs([`123_[${indices.join(',')}]`]), indices.length);
    });

    it('rejects incomplete and invalid task lists', () => {
        for (const jobId of ['123_[1-3,...]', '123_[0-10', '123_[3-1]', '123_[0-10:0]', '123_[1,,4]']) {
            assert.throws(() => countJobs([jobId]), RangeError);
        }
    });
});
