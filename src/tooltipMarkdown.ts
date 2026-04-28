export interface TooltipDetail {
    label: string;
    value: string | number;
}

export interface TooltipSection {
    title: string;
    lines: string[];
}

export interface TooltipMarkdownOptions {
    title: string;
    summary?: string;
    details?: TooltipDetail[];
    sections?: TooltipSection[];
    note?: string;
}

export function formatTooltipMarkdown(options: TooltipMarkdownOptions): string {
    const lines = [`**${options.title}**`];

    if (options.summary) {
        lines.push('', options.summary);
    }

    if (options.details && options.details.length > 0) {
        lines.push('');
        for (const detail of options.details) {
            lines.push(`- **${detail.label}:** ${detail.value}`);
        }
    }

    if (options.sections) {
        for (const section of options.sections) {
            if (section.lines.length === 0) {
                continue;
            }

            lines.push('', `**${section.title}**`);
            for (const line of section.lines) {
                lines.push(`- ${line}`);
            }
        }
    }

    if (options.note) {
        lines.push('', options.note);
    }

    return lines.join('\n');
}
