import chalk from 'chalk';

// === Brand Colors ===
export const brand = {
  emerald: chalk.hex('#10B981'),
  cyan: chalk.hex('#06B6D4'),
} as const;

// === Semantic Colors ===
export const color = {
  primary: chalk.white,
  secondary: chalk.hex('#A1A1AA'),   // zinc-400 — descriptions, metadata
  tertiary: chalk.hex('#71717A'),    // zinc-500 — timestamps, connectors
  success: chalk.hex('#10B981'),
  error: chalk.hex('#EF4444'),
  warning: chalk.hex('#F59E0B'),
  file: chalk.hex('#06B6D4'),        // file paths in brand cyan
  diffAdd: chalk.hex('#10B981'),
  diffRemove: chalk.hex('#EF4444'),
  bold: chalk.bold,
} as const;

// === Icons ===
export const icon = {
  step: '\u25CF',      // ●
  success: '\u2713',   // ✓
  error: '\u2717',     // ✗
  warning: '\u26A0',   // ⚠
  arrow: '\u2192',     // →
  section: '\u00A7',   // §
  dash: '\u2014',      // —
} as const;

// === Tree Connectors ===
export const tree = {
  mid: '\u251C\u2500',   // ├─
  last: '\u2514\u2500',  // └─
  pipe: '\u2502',        // │
} as const;

// === Box Drawing ===
export const box = {
  tl: '\u256D',          // ╭
  tr: '\u256E',          // ╮
  bl: '\u2570',          // ╰
  br: '\u256F',          // ╯
  v: '\u2502',           // │
  h: '\u2500',           // ─
} as const;
