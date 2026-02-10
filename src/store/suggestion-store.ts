import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { SuggestionSet } from '../suggester/types.js';
import { readJson, writeJson } from './persistence.js';

/**
 * Save a suggestion set to disk with a timestamp-based filename.
 */
export async function saveSuggestionSet(
  storeDir: string,
  set: SuggestionSet,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(storeDir, 'suggestions', `${timestamp}.json`);
  await writeJson(path, set);
  return path;
}

/**
 * Load the latest suggestion set from disk.
 * Returns null if no suggestions have been generated.
 */
export async function loadLatestSuggestionSet(
  storeDir: string,
): Promise<SuggestionSet | null> {
  const suggestionsDir = join(storeDir, 'suggestions');

  let files: string[];
  try {
    files = await readdir(suggestionsDir);
  } catch {
    return null;
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json')).sort();
  if (jsonFiles.length === 0) return null;

  const latest = jsonFiles[jsonFiles.length - 1];
  return readJson<SuggestionSet>(join(suggestionsDir, latest));
}

/**
 * Find a suggestion set matching the given cache key.
 * Checks most-recent files first; returns null if no match.
 */
export async function findSuggestionSetByCacheKey(
  storeDir: string,
  cacheKey: string,
): Promise<SuggestionSet | null> {
  const suggestionsDir = join(storeDir, 'suggestions');

  let files: string[];
  try {
    files = await readdir(suggestionsDir);
  } catch {
    return null;
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json')).sort().reverse();

  for (const file of jsonFiles) {
    const set = await readJson<SuggestionSet>(join(suggestionsDir, file));
    if (set?.cacheKey === cacheKey) {
      return set;
    }
  }

  return null;
}
