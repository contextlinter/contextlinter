import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisResult, CrossSessionPattern, Insight } from '../analyzer/types.js';
import type { RulesSnapshot } from '../rules-reader/types.js';
import { readJson } from '../store/persistence.js';
import { loadLatestCrossSessionPatterns } from '../store/analysis-store.js';
import { buildRulesSnapshot } from '../rules-reader/snapshot.js';
import { getCachedRulesSnapshot, cacheRulesSnapshot } from '../store/rules-cache.js';
import { discoverRulesFiles } from '../rules-reader/discovery.js';

const MIN_CONFIDENCE = 0.5;

interface LoadedData {
  insights: Insight[];
  crossPatterns: CrossSessionPattern[];
  rulesSnapshot: RulesSnapshot;
  filteredOut: number;
}

/**
 * Load insights from .contextlinter/analysis/ and rules snapshot for a project.
 */
export async function loadSuggestionInputs(
  storeDir: string,
  projectRoot: string,
): Promise<LoadedData> {
  const [insights, crossPatterns] = await Promise.all([
    loadSessionInsights(storeDir),
    loadLatestCrossSessionPatterns(storeDir),
  ]);

  const rulesSnapshot = await loadOrBuildRulesSnapshot(storeDir, projectRoot);

  // Filter by confidence
  let filteredOut = 0;
  const filteredInsights = insights.filter((i) => {
    if (i.confidence < MIN_CONFIDENCE) {
      filteredOut++;
      return false;
    }
    return true;
  });

  const filteredPatterns = crossPatterns.filter((p) => {
    if (p.confidence < MIN_CONFIDENCE) {
      filteredOut++;
      return false;
    }
    return true;
  });

  return {
    insights: filteredInsights,
    crossPatterns: filteredPatterns,
    rulesSnapshot,
    filteredOut,
  };
}

/**
 * Load all session analysis results from disk.
 */
async function loadSessionInsights(storeDir: string): Promise<Insight[]> {
  const sessionsDir = join(storeDir, 'analysis', 'sessions');
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const insights: Insight[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const result = await readJson<AnalysisResult>(join(sessionsDir, file));
    if (result?.insights) {
      insights.push(...result.insights);
    }
  }

  return insights;
}

/**
 * Load rules snapshot from cache or build fresh.
 */
async function loadOrBuildRulesSnapshot(
  storeDir: string,
  projectRoot: string,
): Promise<RulesSnapshot> {
  const discovered = await discoverRulesFiles(projectRoot);
  const currentMtimes: Record<string, number> = {};
  for (const file of discovered) {
    currentMtimes[file.path] = file.lastModified;
  }

  const cached = await getCachedRulesSnapshot(storeDir, currentMtimes);
  if (cached) return cached;

  const snapshot = await buildRulesSnapshot(projectRoot);
  await cacheRulesSnapshot(storeDir, snapshot);
  return snapshot;
}
