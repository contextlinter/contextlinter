import { v4 as uuidv4 } from 'uuid';
import type { SessionInfo } from '../session-reader/types.js';
import type { AnalysisResult, AnalysisStats, Evidence, Insight, InsightActionHint, InsightCategory } from './types.js';
import { formatConversation, formatToolUsageSummary, isSessionAnalyzable, prepareSession } from './preparer.js';
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
 * Analyze a single session and return structured insights.
 */
export async function analyzeSingleSession(
  session: SessionInfo,
  verbose: boolean,
  model?: ModelName,
): Promise<AnalysisResult> {
  const startTime = Date.now();

  if (!isSessionAnalyzable(session)) {
    return emptyResult(session, Date.now() - startTime);
  }

  const prepared = prepareSession(session);

  if (verbose) {
    printVerbose(
      `Prepared: ${prepared.totalMessagesBeforeFilter} messages → ${prepared.totalMessagesAfterFilter} after filtering` +
      (prepared.wasSampled ? ` → ${prepared.messages.length} after sampling` : ' → no sampling needed'),
    );
    printVerbose(`Tokens estimate: ~${prepared.estimatedTokens.toLocaleString()}`);
  }

  // Build the prompt
  const template = await loadPromptTemplate('session-analysis');
  const prompt = fillTemplate(template, {
    tool_usage_summary: formatToolUsageSummary(prepared.toolUsageSummary),
    conversation: formatConversation(prepared.messages),
  });

  if (verbose) {
    printVerbose('Calling Claude CLI...');
  }

  let insights: Insight[];
  let tokensUsed: number | null = null;

  try {
    const result = await callClaude(prompt, model);
    tokensUsed = result.estimatedTokens;

    if (verbose) {
      printVerbose(`Claude responded in ${(result.durationMs / 1000).toFixed(1)}s (~${result.estimatedTokens} tokens)`);
    }

    const rawInsights = validateInsightsArray(result.parsed);
    insights = rawInsights.map((raw) => normalizeInsight(raw, session.sessionId, session.projectPath));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    printWarning(`LLM error for session ${session.sessionId}: ${msg}`);
    insights = [];
  }

  const analysisTimeMs = Date.now() - startTime;

  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    analyzedAt: new Date().toISOString(),
    insights,
    stats: {
      totalMessages: prepared.totalMessagesBeforeFilter,
      userMessages: session.userMessageCount,
      correctionsDetected: insights.filter((i) =>
        i.category === 'repeated_correction' || i.category === 'rejected_approach',
      ).length,
      insightsGenerated: insights.length,
      analysisTimeMs,
      tokensUsed,
    },
  };
}

/**
 * Validate that the parsed response is an array of insight-like objects.
 */
function validateInsightsArray(parsed: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).category === 'string' &&
      typeof (item as Record<string, unknown>).title === 'string',
  );
}

/**
 * Normalize a raw insight from LLM output into our strict Insight type.
 */
function normalizeInsight(
  raw: Record<string, unknown>,
  sessionId: string,
  projectPath: string,
): Insight {
  return {
    id: uuidv4(),
    category: normalizeCategory(raw.category),
    confidence: normalizeConfidence(raw.confidence),
    title: String(raw.title ?? ''),
    description: String(raw.description ?? ''),
    evidence: normalizeEvidence(raw.evidence),
    suggestedRule: raw.suggestedRule != null ? String(raw.suggestedRule) : null,
    actionHint: normalizeActionHint(raw.actionHint),
    sessionId,
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
  return 0.5;
}

function normalizeActionHint(value: unknown): InsightActionHint {
  if (typeof value === 'string' && VALID_ACTION_HINTS.includes(value as InsightActionHint)) {
    return value as InsightActionHint;
  }
  return 'unclear';
}

function normalizeEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      role: e.role === 'user' ? 'user' as const : 'assistant' as const,
      text: String(e.text ?? '').slice(0, 300),
      timestamp: null,
      messageIndex: typeof e.messageIndex === 'number' ? e.messageIndex : 0,
    }))
    .slice(0, 3);
}

function emptyResult(session: SessionInfo, analysisTimeMs: number): AnalysisResult {
  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    analyzedAt: new Date().toISOString(),
    insights: [],
    stats: {
      totalMessages: session.messageCount,
      userMessages: session.userMessageCount,
      correctionsDetected: 0,
      insightsGenerated: 0,
      analysisTimeMs,
      tokensUsed: null,
    },
  };
}
