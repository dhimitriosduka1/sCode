/**
 * Sums download counts across the VS Marketplace and Open VSX and writes a
 * shields.io "endpoint" badge JSON.
 *
 * No badge service can add up two registries, so we compute the total here and
 * publish it as a static JSON that shields renders via its endpoint badge.
 *
 * Usage: node update-download-badge.mjs <output-path>
 */

const PUBLISHER = 'DhimitriosDuka';
const EXTENSION = 'slurm-cluster-manager';

async function getMarketplaceDownloads() {
    const response = await fetch(
        'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
        {
            method: 'POST',
            headers: {
                'Accept': 'application/json;api-version=3.0-preview.1',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                filters: [{ criteria: [{ filterType: 7, value: `${PUBLISHER}.${EXTENSION}` }] }],
                flags: 914,
            }),
        }
    );

    if (!response.ok) {
        throw new Error(`Marketplace query failed: ${response.status}`);
    }

    const body = await response.json();
    const extension = body.results?.[0]?.extensions?.[0];
    if (!extension) {
        throw new Error('Extension not found on the VS Marketplace');
    }

    const statistic = extension.statistics?.find(s => s.statisticName === 'install');
    if (!statistic) {
        throw new Error('No install statistic returned by the VS Marketplace');
    }

    return Math.round(statistic.value);
}

async function getOpenVsxDownloads() {
    const response = await fetch(`https://open-vsx.org/api/${PUBLISHER}/${EXTENSION}/latest`);

    if (!response.ok) {
        throw new Error(`Open VSX query failed: ${response.status}`);
    }

    const body = await response.json();
    if (typeof body.downloadCount !== 'number') {
        throw new Error('No downloadCount returned by Open VSX');
    }

    return body.downloadCount;
}

function formatCount(total) {
    if (total >= 1_000_000) {
        return `${(total / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (total >= 1_000) {
        return `${(total / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return String(total);
}

const outputPath = process.argv[2];
if (!outputPath) {
    console.error('Usage: node update-download-badge.mjs <output-path>');
    process.exit(1);
}

// Fail loudly rather than publishing a badge built from a partial total
const [marketplace, openVsx] = await Promise.all([
    getMarketplaceDownloads(),
    getOpenVsxDownloads(),
]);

const total = marketplace + openVsx;

console.log(`VS Marketplace: ${marketplace}`);
console.log(`Open VSX:       ${openVsx}`);
console.log(`Total:          ${total}`);

const badge = {
    schemaVersion: 1,
    label: 'Downloads',
    message: formatCount(total),
    color: 'blue',
};

const { writeFile, mkdir } = await import('node:fs/promises');
const { dirname } = await import('node:path');

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(badge, null, 2)}\n`);

console.log(`Wrote ${outputPath}: ${badge.message}`);
