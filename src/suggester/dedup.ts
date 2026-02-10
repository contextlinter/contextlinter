import type { Suggestion, SuggestionPriority } from './types.js';

const PRIORITY_ORDER: Record<SuggestionPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Deduplicate suggestions that target the same topic, then sort by priority + confidence.
 */
export function dedupAndRank(suggestions: Suggestion[]): Suggestion[] {
  const deduped = dedup(suggestions);
  return rank(deduped);
}

/**
 * Remove duplicate suggestions that are about the same topic.
 * Keeps the one with higher priority/confidence.
 */
function dedup(suggestions: Suggestion[]): Suggestion[] {
  const kept: Suggestion[] = [];

  for (const suggestion of suggestions) {
    const duplicateIndex = kept.findIndex((existing) => isSimilar(existing, suggestion));

    if (duplicateIndex === -1) {
      kept.push(suggestion);
    } else {
      // Keep the one with higher priority, or higher confidence if same priority
      const existing = kept[duplicateIndex];
      if (shouldReplace(existing, suggestion)) {
        kept[duplicateIndex] = suggestion;
      }
    }
  }

  return kept;
}

/**
 * Sort suggestions: high priority first, then by confidence descending.
 */
function rank(suggestions: Suggestion[]): Suggestion[] {
  return [...suggestions].sort((a, b) => {
    const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return b.confidence - a.confidence;
  });
}

/**
 * Check if two suggestions are about the same topic.
 * Uses title similarity + target overlap.
 */
function isSimilar(a: Suggestion, b: Suggestion): boolean {
  // Same target file and section — likely related
  if (a.targetFile === b.targetFile && a.targetSection === b.targetSection) {
    // Compare titles with normalized tokens
    if (titleOverlap(a.title, b.title) > 0.6) return true;
  }

  // Same source insights
  if (a.sourceInsightIds.length > 0 && b.sourceInsightIds.length > 0) {
    const overlap = a.sourceInsightIds.filter((id) => b.sourceInsightIds.includes(id));
    if (overlap.length > 0) return true;
  }

  // Very similar titles regardless of target
  if (titleOverlap(a.title, b.title) > 0.8) return true;

  return false;
}

/**
 * Compare titles by normalized word overlap (Jaccard similarity).
 */
function titleOverlap(a: string, b: string): number {
  const wordsA = new Set(normalizeTitle(a));
  const wordsB = new Set(normalizeTitle(b));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2); // Skip short words like "a", "to", "in"
}

function shouldReplace(existing: Suggestion, candidate: Suggestion): boolean {
  const existingPriority = PRIORITY_ORDER[existing.priority];
  const candidatePriority = PRIORITY_ORDER[candidate.priority];

  if (candidatePriority < existingPriority) return true;
  if (candidatePriority > existingPriority) return false;
  return candidate.confidence > existing.confidence;
}
