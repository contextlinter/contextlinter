import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { Insight, CrossSessionPattern } from '../analyzer/types.js';
import type { RulesSnapshot } from '../rules-reader/types.js';
import type { LlmSuggestion, Suggestion, SuggestionType, SuggestionPriority } from './types.js';
import { callClaude, fillTemplate, loadPromptTemplate, SUGGEST_TIMEOUT_MS, type ModelName } from '../analyzer/llm-client.js';
import { buildDiff } from './diff-builder.js';
import { printVerbose, printWarning, printSuggestionBatchProgress } from '../utils/logger.js';

const VALID_TYPES: SuggestionType[] = ['add', 'update', 'remove', 'consolidate', 'split'];
const VALID_PRIORITIES: SuggestionPriority[] = ['high', 'medium', 'low'];
const BATCH_SIZE = 15;

interface GenerateResult {
  suggestions: Suggestion[];
  skipped: Array<{ title: string; reason: string }>;
  durationMs: number;
  batchCount: number;
}

/**
 * Generate suggestions by calling the LLM with insights + rules context.
 * When there are more than BATCH_SIZE insights, splits into batches to avoid
 * timeout and context-window issues. Each batch gets its own LLM call with
 * the full rules snapshot; only insights are split.
 */
export async function generateSuggestions(
  insights: Insight[],
  crossPatterns: CrossSessionPattern[],
  rulesSnapshot: RulesSnapshot,
  verbose: boolean,
  model?: ModelName,
): Promise<GenerateResult> {
  if (insights.length === 0 && crossPatterns.length === 0) {
    return { suggestions: [], skipped: [], durationMs: 0, batchCount: 0 };
  }

  // Build rules content (same for every batch)
  const rulesContent = formatRulesForPrompt(rulesSnapshot);
  const rulesStats = buildRulesStatsForPrompt(rulesSnapshot);
  const template = await loadPromptTemplate('suggestion-generation');
  const insightSessionMap = buildInsightSessionMap(insights, crossPatterns);

  // Build insights payload, sorted by confidence descending so the most
  // important insights land in the first batches.
  const insightsForPrompt = buildInsightsPayload(insights, crossPatterns)
    .sort((a, b) => (b.confidence as number) - (a.confidence as number));

  // Split into batches
  const batches: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < insightsForPrompt.length; i += BATCH_SIZE) {
    batches.push(insightsForPrompt.slice(i, i + BATCH_SIZE));
  }

  const allSuggestions: Suggestion[] = [];
  const allSkipped: Array<{ title: string; reason: string }> = [];
  let totalDurationMs = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const isBatched = batches.length > 1;

    if (isBatched) {
      printSuggestionBatchProgress(batchIdx, batches.length);
    }

    if (verbose) {
      printVerbose(`Calling Claude CLI for suggestion generation${isBatched ? ` (batch ${batchIdx + 1}/${batches.length})` : ''}...`);
    }

    const prompt = fillTemplate(template, {
      rules_content: rulesContent,
      rules_stats: rulesStats,
      insights_json: JSON.stringify(batch, null, 2),
      existing_suggestions_summary: '',
    });

    const result = await callClaude(prompt, model, isBatched ? SUGGEST_TIMEOUT_MS : undefined);
    totalDurationMs += result.durationMs;

    if (verbose) {
      printVerbose(`Claude responded in ${(result.durationMs / 1000).toFixed(1)}s`);
    }

    const rawSuggestions = validateSuggestionsArray(result.parsed);
    if (rawSuggestions.length === 0) {
      if (!isBatched) {
        printWarning('LLM returned no valid suggestions.');
      }
      continue;
    }

    for (const raw of rawSuggestions) {
      if (raw.skipped) {
        allSkipped.push({
          title: raw.title ?? 'Unknown',
          reason: raw.skipReason ?? 'already covered',
        });
      } else {
        const suggestion = buildSuggestion(raw, rulesSnapshot, insightSessionMap);
        if (suggestion) {
          allSuggestions.push(suggestion);
        }
      }
    }
  }

  if (allSuggestions.length === 0 && allSkipped.length === 0) {
    printWarning('LLM returned no valid suggestions across all batches.');
  }

  return { suggestions: allSuggestions, skipped: allSkipped, durationMs: totalDurationMs, batchCount: batches.length };
}

/**
 * Format all rules files content for the prompt.
 */
export function formatRulesForPrompt(snapshot: RulesSnapshot): string {
  if (snapshot.files.length === 0) {
    return '(No rules files exist yet. CLAUDE.md has not been created.)';
  }

  const parts: string[] = [];
  for (const file of snapshot.files) {
    parts.push(`### File: ${file.relativePath} (${file.scope} scope, ${file.rules.length} rules)\n\n${file.content}`);
  }
  return parts.join('\n\n---\n\n');
}

/**
 * Build the insights payload for the prompt, combining insights and cross-session patterns.
 * Cross-session patterns are marked as such so the LLM can prioritize them.
 */
export function buildInsightsPayload(
  insights: Insight[],
  crossPatterns: CrossSessionPattern[],
): Array<Record<string, unknown>> {
  const payload: Array<Record<string, unknown>> = [];

  // Filter to actionable insights (those with rule suggestions)
  for (const insight of insights) {
    if (!insight.suggestedRule && insight.actionHint === 'prompt_improvement') continue;

    payload.push({
      id: insight.id,
      source: 'single-session',
      category: insight.category,
      confidence: insight.confidence,
      title: insight.title,
      description: insight.description,
      suggestedRule: insight.suggestedRule,
      actionHint: insight.actionHint,
      sessionId: insight.sessionId,
    });
  }

  for (const pattern of crossPatterns) {
    if (!pattern.suggestedRule && pattern.actionHint === 'prompt_improvement') continue;

    payload.push({
      id: pattern.id,
      source: 'cross-session',
      category: pattern.category,
      confidence: pattern.confidence,
      title: pattern.title,
      description: pattern.description,
      suggestedRule: pattern.suggestedRule,
      actionHint: pattern.actionHint,
      sessionCount: pattern.occurrences.length,
    });
  }

  return payload;
}

/**
 * Build a map from insight ID to session IDs for traceability.
 */
export function buildInsightSessionMap(
  insights: Insight[],
  crossPatterns: CrossSessionPattern[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const insight of insights) {
    map.set(insight.id, [insight.sessionId]);
  }

  for (const pattern of crossPatterns) {
    const sessionIds = pattern.occurrences.map((o) => o.sessionId);
    map.set(pattern.id, sessionIds);
  }

  return map;
}

/**
 * Build a Suggestion from the raw LLM output.
 */
export function buildSuggestion(
  raw: LlmSuggestion,
  rulesSnapshot: RulesSnapshot,
  insightSessionMap: Map<string, string[]>,
): Suggestion | null {
  const type = normalizeType(raw.type);
  const priority = normalizePriority(raw.priority);
  const targetFile = raw.targetFile ?? 'CLAUDE.md';
  const targetSection = raw.targetSection ?? null;

  const diff = buildDiff(raw, rulesSnapshot, targetFile, targetSection);
  if (!diff) return null;

  // Warn if content is verbose (safety net for prompt non-compliance)
  const MAX_CONTENT_LINES = 5;
  if (type !== 'split' && type !== 'consolidate') {
    const rawAdd = typeof raw.content.add === 'string' ? raw.content.add
      : Array.isArray(raw.content.add) ? raw.content.add.join('\n')
      : null;
    if (rawAdd) {
      const nonEmptyLines = rawAdd.split('\n').filter((l) => l.trim().length > 0).length;
      if (nonEmptyLines > MAX_CONTENT_LINES) {
        printWarning(`Suggestion "${raw.title}" has ${nonEmptyLines} content lines (max ${MAX_CONTENT_LINES}). Consider making it more concise.`);
      }
    }
  }

  // For split type, content.add holds the destination file path
  const splitTarget = type === 'split' ? normalizeSplitTarget(raw.content.add) : null;

  // Collect source session IDs from insight IDs
  const sourceSessionIds = new Set<string>();
  const insightIds = raw.insightIds ?? [];
  for (const id of insightIds) {
    const sessions = insightSessionMap.get(id);
    if (sessions) {
      for (const s of sessions) sourceSessionIds.add(s);
    }
  }

  return {
    id: uuidv4(),
    type,
    priority,
    confidence: type === 'split' ? 0.85 : estimateConfidence(raw, insightSessionMap),
    title: raw.title ?? 'Untitled suggestion',
    rationale: raw.rationale ?? '',
    targetFile,
    targetSection,
    splitTarget,
    diff,
    sourceInsightIds: insightIds,
    sourceSessionIds: [...sourceSessionIds],
    status: 'pending',
  };
}

/**
 * Estimate confidence from the raw suggestion's source insights.
 */
function estimateConfidence(
  raw: LlmSuggestion,
  insightSessionMap: Map<string, string[]>,
): number {
  const insightIds = raw.insightIds ?? [];
  if (insightIds.length === 0) return 0.6;

  // Count total sessions backing this suggestion
  const allSessions = new Set<string>();
  for (const id of insightIds) {
    const sessions = insightSessionMap.get(id);
    if (sessions) {
      for (const s of sessions) allSessions.add(s);
    }
  }

  // More sessions = higher confidence
  const sessionCount = allSessions.size;
  if (sessionCount >= 3) return 0.95;
  if (sessionCount >= 2) return 0.85;
  return 0.7;
}

function normalizeType(value: unknown): SuggestionType {
  if (typeof value === 'string' && VALID_TYPES.includes(value as SuggestionType)) {
    return value as SuggestionType;
  }
  return 'add';
}

function normalizePriority(value: unknown): SuggestionPriority {
  if (typeof value === 'string' && VALID_PRIORITIES.includes(value as SuggestionPriority)) {
    return value as SuggestionPriority;
  }
  return 'medium';
}

/**
 * Validate that the parsed LLM output is an array of suggestion-like objects.
 */
function validateSuggestionsArray(parsed: unknown): LlmSuggestion[] {
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).title === 'string',
    )
    .map((item) => {
      const type = normalizeType(item.type);
      const content = normalizeContent(item.content);

      // No downgrade needed: diff-builder reads actual section content from
      // the rules snapshot for update type, so remove text from LLM is optional.

      return {
        type,
        targetFile: typeof item.targetFile === 'string' ? item.targetFile : 'CLAUDE.md',
        targetSection: typeof item.targetSection === 'string' ? item.targetSection : null,
        title: String(item.title),
        rationale: typeof item.rationale === 'string' ? item.rationale : '',
        priority: normalizePriority(item.priority),
        content,
        insightIds: normalizeInsightIds(item.insightIds),
        skipped: Boolean(item.skipped),
        skipReason: typeof item.skipReason === 'string' ? item.skipReason : null,
      };
    });
}

function normalizeContent(value: unknown): { add: string | string[] | null; remove: string | string[] | null } {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return {
      add: normalizeContentField(obj.add),
      remove: normalizeContentField(obj.remove),
    };
  }
  // If content is a plain string, treat it as add
  if (typeof value === 'string') {
    return { add: value, remove: null };
  }
  return { add: null, remove: null };
}

function normalizeContentField(value: unknown): string | string[] | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return null;
}

function normalizeInsightIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function normalizeSplitTarget(value: string | string[] | null): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return value[0];
  return null;
}

/**
 * Build rules stats string for the prompt so the LLM can make informed split decisions.
 * Shows total rules per file and per-section breakdowns.
 */
export function buildRulesStatsForPrompt(snapshot: RulesSnapshot): string {
  if (snapshot.files.length === 0) {
    return '(No rules files exist yet.)';
  }

  const parts: string[] = [];
  parts.push(`Total rules across all files: ${snapshot.stats.totalRules}`);
  parts.push('');

  for (const file of snapshot.files) {
    parts.push(`### ${file.relativePath}: ${file.rules.length} rules`);

    // Group rules by section
    const sectionMap = new Map<string, typeof file.rules>();
    for (const rule of file.rules) {
      const section = rule.section ?? '(no section)';
      if (!sectionMap.has(section)) {
        sectionMap.set(section, []);
      }
      sectionMap.get(section)!.push(rule);
    }

    // Sort sections by rule count descending
    const sections = [...sectionMap.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [section, rules] of sections) {
      const lineRange = `lines ${rules[0].lineStart}-${rules[rules.length - 1].lineEnd}`;
      parts.push(`  - ${section}: ${rules.length} rules (${lineRange})`);
    }

    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Generate suggestions for a small set of insights from a single session.
 * Passes existing suggestions as context so the LLM can avoid duplicates.
 * No batching — designed for 1-10 insights per call.
 */
export async function generateSessionSuggestions(
  insights: Insight[],
  rulesSnapshot: RulesSnapshot,
  existingSuggestions: Suggestion[],
  verbose: boolean,
  model?: ModelName,
): Promise<GenerateResult> {
  if (insights.length === 0) {
    return { suggestions: [], skipped: [], durationMs: 0, batchCount: 0 };
  }

  const rulesContent = formatRulesForPrompt(rulesSnapshot);
  const rulesStats = buildRulesStatsForPrompt(rulesSnapshot);
  const template = await loadPromptTemplate('suggestion-generation');
  const insightSessionMap = buildInsightSessionMap(insights, []);

  const insightsForPrompt = buildInsightsPayload(insights, [])
    .sort((a, b) => (b.confidence as number) - (a.confidence as number));

  // Build existing suggestions summary for the prompt
  const existingSummary = formatExistingSuggestions(existingSuggestions);

  if (verbose) {
    printVerbose(`Generating suggestions for ${insights.length} insight(s)${existingSuggestions.length > 0 ? ` (${existingSuggestions.length} existing for dedup context)` : ''}...`);
  }

  const prompt = fillTemplate(template, {
    rules_content: rulesContent,
    rules_stats: rulesStats,
    insights_json: JSON.stringify(insightsForPrompt, null, 2),
    existing_suggestions_summary: existingSummary,
  });

  const result = await callClaude(prompt, model, SUGGEST_TIMEOUT_MS);

  if (verbose) {
    printVerbose(`Claude responded in ${(result.durationMs / 1000).toFixed(1)}s`);
  }

  const rawSuggestions = validateSuggestionsArray(result.parsed);
  const suggestions: Suggestion[] = [];
  const skipped: Array<{ title: string; reason: string }> = [];

  for (const raw of rawSuggestions) {
    if (raw.skipped) {
      skipped.push({
        title: raw.title ?? 'Unknown',
        reason: raw.skipReason ?? 'already covered',
      });
    } else {
      const suggestion = buildSuggestion(raw, rulesSnapshot, insightSessionMap);
      if (suggestion) {
        suggestions.push(suggestion);
      }
    }
  }

  return { suggestions, skipped, durationMs: result.durationMs, batchCount: 1 };
}

/**
 * Build a compact summary of existing suggestions for the prompt.
 * Returns empty string if no existing suggestions, or a full section with header.
 */
function formatExistingSuggestions(suggestions: Suggestion[]): string {
  if (suggestions.length === 0) return '';

  const summary = suggestions.map((s) => ({
    title: s.title,
    type: s.type,
    targetFile: s.targetFile,
    targetSection: s.targetSection,
  }));

  return `## Already generated suggestions (from earlier sessions in this run)

<existing_suggestions>
${JSON.stringify(summary, null, 2)}
</existing_suggestions>`;
}

/**
 * Compute a cache key for a set of insights + rules content + prompt version.
 * Any change to the inputs produces a different key.
 */
export function computeSuggestionCacheKey(
  insightIds: string[],
  crossPatternIds: string[],
  rulesSnapshot: RulesSnapshot,
  promptVersion: string,
): string {
  const hash = createHash('sha256');

  const sortedIds = [...insightIds, ...crossPatternIds].sort();
  hash.update(sortedIds.join('\n'));

  hash.update('\x00');
  for (const file of rulesSnapshot.files) {
    hash.update(file.relativePath);
    hash.update('\x00');
    hash.update(file.content);
    hash.update('\x00');
  }

  hash.update('\x00prompt:');
  hash.update(promptVersion);

  return hash.digest('hex').slice(0, 16);
}
