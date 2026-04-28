import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatTooltipMarkdown } from '../tooltipMarkdown';

describe('tooltip markdown formatting', () => {
    it('formats title, summary, details, sections, and note with separated blocks', () => {
        assert.equal(formatTooltipMarkdown({
            title: 'Job: train-transformer',
            summary: 'Running · 91001',
            details: [
                { label: 'Partition', value: 'gpu' },
                { label: 'Progress', value: '●●○○ 50%' },
            ],
            sections: [
                {
                    title: 'Output files',
                    lines: [
                        'stdout: `/tmp/slurm.out`',
                        'stderr: `/tmp/slurm.err`',
                    ],
                },
            ],
            note: 'Click a file to open it.',
        }), [
            '**Job: train-transformer**',
            '',
            'Running · 91001',
            '',
            '- **Partition:** gpu',
            '- **Progress:** ●●○○ 50%',
            '',
            '**Output files**',
            '- stdout: `/tmp/slurm.out`',
            '- stderr: `/tmp/slurm.err`',
            '',
            'Click a file to open it.',
        ].join('\n'));
    });

    it('skips empty optional blocks', () => {
        assert.equal(formatTooltipMarkdown({
            title: 'Partition: `gpu`',
            sections: [{ title: 'Empty', lines: [] }],
        }), '**Partition: `gpu`**');
    });
});
