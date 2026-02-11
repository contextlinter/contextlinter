import { brand, color, icon, tree } from './theme.js';

/**
 * Top-level step marker: "● Text" in brand emerald + bold.
 */
export function step(text: string): string {
  return `${brand.emerald(icon.step)} ${color.bold(text)}`;
}

/**
 * Middle sub-step: "  ├─ text" with tertiary connector.
 */
export function substep(text: string): string {
  return `  ${color.tertiary(tree.mid)} ${text}`;
}

/**
 * Last sub-step: "  └─ text" with tertiary connector.
 */
export function lastSub(text: string): string {
  return `  ${color.tertiary(tree.last)} ${text}`;
}

/**
 * Success line with checkmark: "  └─ ✓ text" (or ├─ if not last).
 */
export function success(text: string, isLast = true): string {
  const connector = isLast ? tree.last : tree.mid;
  return `  ${color.tertiary(connector)} ${color.success(`${icon.success} ${text}`)}`;
}

/**
 * Error with ✗ symbol.
 */
export function error(text: string): string {
  return color.error(`${icon.error} ${text}`);
}

/**
 * Warning with ⚠ symbol.
 */
export function warn(text: string): string {
  return color.warning(`${icon.warning} ${text}`);
}

/**
 * File path in brand cyan.
 */
export function filePath(path: string): string {
  return color.file(path);
}

/**
 * Secondary text (zinc-400) — descriptions, metadata.
 */
export function secondary(text: string): string {
  return color.secondary(text);
}

/**
 * Tertiary text (zinc-500) — timestamps, debug info.
 */
export function tertiary(text: string): string {
  return color.tertiary(text);
}

/**
 * Tree continuation pipe: "  │  text" — for multi-line content under a substep.
 */
export function treeCont(text: string): string {
  return `  ${color.tertiary(tree.pipe)}  ${text}`;
}

/**
 * Diff addition line: "+ text" in emerald.
 */
export function diffAdd(text: string): string {
  return color.diffAdd(`+ ${text}`);
}

/**
 * Diff removal line: "- text" in red.
 */
export function diffRemove(text: string): string {
  return color.diffRemove(`- ${text}`);
}

/**
 * Priority label with consistent width padding.
 */
export function priorityLabel(priority: string): string {
  switch (priority) {
    case 'high':
      return color.bold('HIGH');
    case 'medium':
      return color.bold('MED ');
    case 'low':
      return color.bold('LOW ');
    default:
      return '    ';
  }
}

/**
 * Shorten paths by replacing $HOME with ~.
 */
export function shortPath(fullPath: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}
