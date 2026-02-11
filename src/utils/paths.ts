import { access, realpath } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Decode a Claude Code encoded directory name back to a filesystem path.
 * Claude encodes `/Users/john/myproject` as `-Users-john-myproject`.
 */
export function decodeProjectPath(encoded: string): string {
  // Replace leading dash and all dashes with path separators
  return encoded.replace(/-/g, '/');
}

/**
 * Encode a filesystem path into Claude Code's directory name format.
 */
export function encodeProjectPath(fsPath: string): string {
  return fsPath.replace(/\//g, '-');
}

export function getClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Resolve the Claude projects directory, following symlinks.
 * Returns null if the directory doesn't exist or isn't accessible.
 */
export async function resolveClaudeProjectsDir(
  baseDir?: string,
): Promise<string | null> {
  const dir = baseDir ?? getClaudeProjectsDir();
  try {
    return await realpath(dir);
  } catch {
    return null;
  }
}

export function isWindowsPlatform(): boolean {
  return platform() === 'win32';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Extract the session UUID from a JSONL filename.
 * e.g. "abc123-def456.jsonl" → "abc123-def456"
 */
export function extractSessionId(filename: string): string {
  return filename.replace(/\.jsonl$/, '');
}

const PROJECT_ROOT_MARKERS = ['.git', 'package.json', 'CLAUDE.md', '.contextlinter'];

/**
 * Find the project root by walking up from `startDir` looking for marker files/dirs.
 * Stops at the home directory — never returns $HOME itself as a project root.
 * Returns null if no marker is found.
 */
export async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = resolve(startDir);
  const home = homedir();

  while (true) {
    // Don't treat home directory as a project root
    if (current === home) return null;

    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        await access(join(current, marker));
        return current;
      } catch {
        // marker not found, continue
      }
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
