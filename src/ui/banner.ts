import { brand, color, box } from './theme.js';
import { shortPath } from './format.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../../package.json') as { version: string };

export { VERSION };

// Strip ANSI escape codes for width calculation.
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Build the startup banner as an array of lines.
 *
 * Example output:
 *   ╭─── ContextLinter v0.2.0 · Analyze ─────────────────────╮
 *   │  Project: ~/work/myproject                              │
 *   │  Sessions: 12                                            │
 *   │  Model: sonnet                                           │
 *   ╰────────────────────────────────────────────────────────╯
 */
export function buildBanner(
  commandLabel: string,
  projectPath?: string,
  extra?: Record<string, string>,
): string[] {
  const title = `ContextLinter v${VERSION} ${color.tertiary('\u00B7')} ${commandLabel}`;
  const titlePlain = `ContextLinter v${VERSION} \u00B7 ${commandLabel}`;

  // Content lines (styled)
  const contentLines: string[] = [];
  if (projectPath) {
    contentLines.push(`${color.secondary('Scope:')} ${color.file(shortPath(projectPath))}`);
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      contentLines.push(`${color.secondary(key + ':')} ${value}`);
    }
  }

  // Calculate inner width
  const titleWidth = titlePlain.length + 5; // "─── " prefix (4) + trailing " " (1)
  const contentWidths = contentLines.map((l) => stripAnsi(l).length + 2); // 2 = leading/trailing space
  const minWidth = 60;
  const innerWidth = Math.max(minWidth, titleWidth + 4, ...contentWidths);

  const lines: string[] = [];

  // Top edge: ╭─── Title ────────╮
  const titlePadCount = Math.max(0, innerWidth - titleWidth);
  const topLine =
    color.tertiary(box.tl + box.h.repeat(3) + ' ') +
    brand.emerald(`ContextLinter v${VERSION}`) +
    color.tertiary(` \u00B7 `) +
    color.bold(commandLabel) +
    color.tertiary(' ' + box.h.repeat(titlePadCount) + box.tr);
  lines.push(topLine);

  // Content lines: │  content  │
  const emptyRow = color.tertiary(box.v) + ' '.repeat(innerWidth) + color.tertiary(box.v);
  if (contentLines.length > 0) {
    lines.push(emptyRow);
    for (const line of contentLines) {
      const visibleLen = stripAnsi(line).length;
      const pad = Math.max(0, innerWidth - visibleLen - 2);
      lines.push(
        color.tertiary(box.v) + `  ${line}${' '.repeat(pad)}` + color.tertiary(box.v),
      );
    }
    lines.push(emptyRow);
  }

  // Bottom edge: ╰──────────────╯
  const bottomWidth = innerWidth;
  lines.push(color.tertiary(box.bl + box.h.repeat(bottomWidth) + box.br));

  return lines;
}
