import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import type { RulesSnapshot } from '../rules-reader/types.js';
import { readJson, writeJson } from './persistence.js';

interface CachedRulesSnapshot extends RulesSnapshot {
  _cachedAt: number;
  _fileMtimes: Record<string, number>;
}

function getCachePath(cacheDir: string): string {
  return join(cacheDir, 'cache', 'rules-snapshot.json');
}

/**
 * Get cached rules snapshot if all source files are unchanged.
 * Returns null if cache is stale or missing.
 */
export async function getCachedRulesSnapshot(
  cacheDir: string,
  currentMtimes: Record<string, number>,
): Promise<RulesSnapshot | null> {
  const cachePath = getCachePath(cacheDir);
  const cached = await readJson<CachedRulesSnapshot>(cachePath);
  if (!cached) return null;

  // Check if any file has been modified since caching
  const cachedMtimes = cached._fileMtimes;

  // Different set of files → stale
  const cachedPaths = Object.keys(cachedMtimes).sort();
  const currentPaths = Object.keys(currentMtimes).sort();
  if (cachedPaths.length !== currentPaths.length) return null;
  for (let i = 0; i < cachedPaths.length; i++) {
    if (cachedPaths[i] !== currentPaths[i]) return null;
  }

  // Any file modified → stale
  for (const [path, mtime] of Object.entries(currentMtimes)) {
    const cachedMtime = cachedMtimes[path];
    if (cachedMtime === undefined || mtime > cachedMtime) return null;
  }

  const { _cachedAt: _, _fileMtimes: __, ...snapshot } = cached;
  return snapshot;
}

/**
 * Cache a rules snapshot to disk.
 */
export async function cacheRulesSnapshot(
  cacheDir: string,
  snapshot: RulesSnapshot,
): Promise<void> {
  const cachePath = getCachePath(cacheDir);

  const fileMtimes: Record<string, number> = {};
  for (const file of snapshot.files) {
    fileMtimes[file.path] = file.lastModified;
  }

  const cached: CachedRulesSnapshot = {
    ...snapshot,
    _cachedAt: Date.now(),
    _fileMtimes: fileMtimes,
  };

  await writeJson(cachePath, cached);
}

/**
 * Invalidate the rules cache so the next suggest re-parses all rules files.
 * Call this after apply modifies any rules file.
 */
export async function invalidateRulesCache(cacheDir: string): Promise<void> {
  const cachePath = getCachePath(cacheDir);
  try {
    await unlink(cachePath);
  } catch {
    // Cache file doesn't exist — nothing to invalidate
  }
}
