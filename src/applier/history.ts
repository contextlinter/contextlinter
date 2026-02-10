import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RulesHistoryEntry } from './types.js';

/**
 * Append a single history entry to the JSONL file.
 * Creates parent directories if needed. Append-only — never rewrites the file.
 */
export async function appendHistoryEntry(
  historyPath: string,
  entry: RulesHistoryEntry,
): Promise<void> {
  await mkdir(dirname(historyPath), { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  await appendFile(historyPath, line, 'utf-8');
}

/**
 * Build a history entry from a suggestion and its apply context.
 */
export function buildHistoryEntry(
  action: RulesHistoryEntry['action'],
  file: string,
  section: string | null,
  content: string,
  previousContent: string | null,
  reason: string,
  sourceInsightIds: string[],
  sourceSessionIds: string[],
  confidence: number,
): RulesHistoryEntry {
  return {
    timestamp: new Date().toISOString(),
    action,
    file,
    section,
    content,
    previousContent,
    reason,
    sourceInsightIds,
    sourceSessionIds,
    confidence,
  };
}
