import { access, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { RuleScope } from './types.js';

export interface DiscoveredFile {
  path: string;
  scope: RuleScope;
  relativePath: string;
  lastModified: number;
  sizeBytes: number;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.contextlinter',
]);

/**
 * Discover all rules files for a project.
 */
export async function discoverRulesFiles(projectRoot: string): Promise<DiscoveredFile[]> {
  const files: DiscoveredFile[] = [];

  // 1. Global: ~/.claude/CLAUDE.md
  await tryAdd(files, join(homedir(), '.claude', 'CLAUDE.md'), 'global', projectRoot);

  // 2. Project root: ./CLAUDE.md
  await tryAdd(files, join(projectRoot, 'CLAUDE.md'), 'project', projectRoot);

  // 3. Project local: ./CLAUDE.local.md
  await tryAdd(files, join(projectRoot, 'CLAUDE.local.md'), 'project_local', projectRoot);

  // 4. Alternative location: ./.claude/CLAUDE.md
  await tryAdd(files, join(projectRoot, '.claude', 'CLAUDE.md'), 'project', projectRoot);

  // 5. Modular rules: ./.claude/rules/*.md
  await discoverModularRules(files, projectRoot);

  // 6. Subdirectory CLAUDE.md (max 3 levels deep)
  await discoverSubdirRules(files, projectRoot, projectRoot, 0);

  return files;
}

async function tryAdd(
  files: DiscoveredFile[],
  filePath: string,
  scope: RuleScope,
  projectRoot: string,
): Promise<void> {
  try {
    const resolved = await realpath(filePath);

    // Avoid duplicates (e.g. symlinks resolving to the same file)
    if (files.some((f) => f.path === resolved)) return;

    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) return;

    files.push({
      path: resolved,
      scope,
      relativePath: relative(projectRoot, resolved) || resolved,
      lastModified: fileStat.mtimeMs,
      sizeBytes: fileStat.size,
    });
  } catch {
    // File doesn't exist or isn't accessible
  }
}

async function discoverModularRules(
  files: DiscoveredFile[],
  projectRoot: string,
): Promise<void> {
  const rulesDir = join(projectRoot, '.claude', 'rules');
  try {
    await access(rulesDir);
  } catch {
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(rulesDir);
  } catch {
    return;
  }

  // Sort for deterministic ordering
  entries.sort();

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    await tryAdd(files, join(rulesDir, entry), 'project', projectRoot);
  }
}

async function discoverSubdirRules(
  files: DiscoveredFile[],
  projectRoot: string,
  currentDir: string,
  depth: number,
): Promise<void> {
  if (depth >= 3) return;

  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    if (entry.startsWith('.') && entry !== '.claude') continue;

    const entryPath = join(currentDir, entry);

    try {
      const entryStat = await stat(entryPath);
      if (!entryStat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Skip project root itself and .claude dir (handled separately)
    if (entryPath === projectRoot) continue;
    if (entry === '.claude') continue;

    await tryAdd(files, join(entryPath, 'CLAUDE.md'), 'subdirectory', projectRoot);
    await discoverSubdirRules(files, projectRoot, entryPath, depth + 1);
  }
}
