import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisResult, CrossSessionPattern } from '../analyzer/types.js';
import { readJson, writeJson } from './persistence.js';

/**
 * Save a single-session analysis result to disk.
 */
export async function saveAnalysisResult(
  storeDir: string,
  result: AnalysisResult,
): Promise<void> {
  const path = join(storeDir, 'analysis', 'sessions', `${result.sessionId}.json`);
  await writeJson(path, result);
}

/**
 * Load a single-session analysis result from disk.
 */
export async function loadAnalysisResult(
  storeDir: string,
  sessionId: string,
): Promise<AnalysisResult | null> {
  const path = join(storeDir, 'analysis', 'sessions', `${sessionId}.json`);
  return readJson<AnalysisResult>(path);
}

/**
 * Save cross-session patterns to disk.
 */
export async function saveCrossSessionPatterns(
  storeDir: string,
  patterns: CrossSessionPattern[],
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(storeDir, 'analysis', 'cross-session', `${timestamp}.json`);
  await writeJson(path, patterns);
}

/**
 * Load the latest cross-session patterns from disk.
 * Colocated with save to guarantee path consistency.
 */
export async function loadLatestCrossSessionPatterns(
  storeDir: string,
): Promise<CrossSessionPattern[]> {
  const crossDir = join(storeDir, 'analysis', 'cross-session');
  let files: string[];
  try {
    files = await readdir(crossDir);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
  if (jsonFiles.length === 0) return [];

  // Load the latest file
  const latest = jsonFiles[jsonFiles.length - 1];
  const patterns = await readJson<CrossSessionPattern[]>(join(crossDir, latest));
  return patterns ?? [];
}
