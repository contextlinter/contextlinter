import { v4 as uuidv4 } from 'uuid';
import type { AnalysisResult, CrossSessionPattern, InsightActionHint, InsightCategory, PatternOccurrence } from './types.js';
import { callClaude, fillTemplate, loadPromptTemplate, type ModelName } from './llm-client.js';
import { printVerbose, printWarning } from '../utils/logger.js';

const VALID_CATEGORIES: InsightCategory[] = [
  'missing_project_knowledge',
  'repeated_correction',
  'rejected_approach',
  'intent_clarification',
  'convention_establishment',
  'tool_command_correction',
  'tool_usage_pattern',
];

const VALID_ACTION_HINTS: InsightActionHint[] = [
  'add_to_rules',
  'update_rules',
  'add_to_global_rules',
  'prompt_improvement',
  'unclear',
];

/**
 * Synthesize patterns across multiple session analysis results.
 */
export async function synthesizeCrossSessions(
  results: AnalysisResult[],
  projectPath: string,
  verbose: boolean,
  model?: ModelName,
): Promise<CrossSessionPattern[]> {
  const allInsights = results.flatMap((r) => r.insights);

  if (allInsights.length === 0) {
    if (verbose) printVerbose('No insights to synthesize across sessions.');
    return [];
  }

  if (results.length < 2) {
    if (verbose) printVerbose('Need at least 2 sessions for cross-session synthesis.');
    return [];
  }

  // Prepare insights summary for the LLM
  const insightsSummary = allInsights.map((i) => ({
    id: i.id,
    sessionId: i.sessionId,
    category: i.category,
    confidence: i.confidence,
    title: i.title,
    description: i.description,
    suggestedRule: i.suggestedRule,
  }));

  const template = await loadPromptTemplate('cross-session-synthesis');
  const prompt = fillTemplate(template, {
    insights_json: JSON.stringify(insightsSummary, null, 2),
  });

  if (verbose) {
    printVerbose(`Cross-session synthesis: ${allInsights.length} insights from ${results.length} sessions`);
    printVerbose('Calling Claude CLI...');
  }

  try {
    const result = await callClaude(prompt, model);

    if (verbose) {
      printVerbose(`Claude responded in ${(result.durationMs / 1000).toFixed(1)}s`);
    }

    const rawPatterns = validatePatternsArray(result.parsed);
    return rawPatterns.map((raw) => normalizePattern(raw, projectPath));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    printWarning(`Cross-session synthesis error: ${msg}`);
    return [];
  }
}

function validatePatternsArray(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).category === 'string' &&
      typeof (item as Record<string, unknown>).title === 'string',
  );
}

function normalizePattern(
  raw: Record<string, unknown>,
  projectPath: string,
): CrossSessionPattern {
  return {
    id: uuidv4(),
    category: normalizeCategory(raw.category),
    confidence: normalizeConfidence(raw.confidence),
    title: String(raw.title ?? ''),
    description: String(raw.description ?? ''),
    occurrences: normalizeOccurrences(raw.occurrences),
    suggestedRule: raw.suggestedRule != null ? String(raw.suggestedRule) : null,
    actionHint: normalizeActionHint(raw.actionHint),
    projectPath,
  };
}

function normalizeCategory(value: unknown): InsightCategory {
  if (typeof value === 'string' && VALID_CATEGORIES.includes(value as InsightCategory)) {
    return value as InsightCategory;
  }
  return 'missing_project_knowledge';
}

function normalizeConfidence(value: unknown): number {
  if (typeof value === 'number' && value >= 0 && value <= 1) return value;
  return 0.6;
}

function normalizeActionHint(value: unknown): InsightActionHint {
  if (typeof value === 'string' && VALID_ACTION_HINTS.includes(value as InsightActionHint)) {
    return value as InsightActionHint;
  }
  return 'unclear';
}

function normalizeOccurrences(value: unknown): PatternOccurrence[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .map((o) => ({
      sessionId: String(o.sessionId ?? ''),
      insightId: String(o.insightId ?? ''),
      timestamp: null,
    }));
}
