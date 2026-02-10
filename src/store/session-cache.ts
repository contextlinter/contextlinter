import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionInfo } from '../session-reader/types.js';
import { readJson, writeJson } from './persistence.js';

/**
 * Get the cache file path for a session.
 */
function getCachePath(cacheDir: string, sessionId: string): string {
  return join(cacheDir, 'cache', 'sessions', `${sessionId}.json`);
}

/**
 * Check if a cached session is still valid (JSONL file hasn't been modified since caching).
 */
export async function getCachedSession(
  cacheDir: string,
  sessionId: string,
  jsonlPath: string,
): Promise<SessionInfo | null> {
  const cachePath = getCachePath(cacheDir, sessionId);
  const cached = await readJson<SessionInfo & { _cachedAt: number }>(cachePath);
  if (!cached) return null;

  try {
    const fileStat = await stat(jsonlPath);
    const jsonlMtime = fileStat.mtimeMs;
    if (jsonlMtime > cached._cachedAt) return null;
  } catch {
    return null;
  }

  const { _cachedAt: _, ...sessionInfo } = cached;
  return sessionInfo;
}

/**
 * Cache a parsed session to disk.
 */
export async function cacheSession(
  cacheDir: string,
  session: SessionInfo,
): Promise<void> {
  const cachePath = getCachePath(cacheDir, session.sessionId);
  await writeJson(cachePath, { ...session, _cachedAt: Date.now() });
}
