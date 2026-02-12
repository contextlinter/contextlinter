import type { SessionInfo } from '../session-reader/types.js';
import type { AnalysisResult, CrossSessionPattern } from '../analyzer/types.js';
import type { RulesSnapshot } from '../rules-reader/types.js';
import type { LlmSuggestion, Suggestion, SuggestionSet, SuggestionStats } from '../suggester/types.js';
import type { ModelName } from '../analyzer/llm-client.js';
import type {
  PipelineOptions,
  PipelineCallbacks,
  PipelineResult,
  PipelineStats,
  SessionPipelineResult,
  PipelineAccumulator,
} from './types.js';

import { analyzeAndSuggestSession } from '../analyzer/single-session.js';
import { synthesizeCrossSessions } from '../analyzer/cross-session.js';
import { generateSessionSuggestions, buildSuggestion, buildInsightSessionMap } from '../suggester/generator.js';
import { dedupAndRank } from '../suggester/dedup.js';
import { saveAnalysisResult, saveCrossSessionPatterns } from '../store/analysis-store.js';
import {
  loadAuditLog,
  markSessionAnalyzed,
  markCrossSessionDone,
  saveAuditLog,
} from '../store/audit.js';
import { saveSuggestionSet } from '../store/suggestion-store.js';
import { getPromptVersion } from '../analyzer/llm-client.js';
import { printWarning, printVerbose } from '../utils/logger.js';
import { startWithConcurrency } from './concurrency.js';

const ANALYSIS_CONCURRENCY = 3;

interface CombinedTaskResult {
  analysisResult: AnalysisResult;
  rawSuggestions: LlmSuggestion[];
}

/**
 * Run the per-session pipeline: combined analyze+suggest in parallel,
 * then incremental dedup as each session completes.
 *
 * @param sessions - sessions to process (already filtered and confirmed)
 * @param storeDir - .contextlinter/ directory
 * @param projectRoot - project root path
 * @param rulesSnapshot - current rules state
 * @param opts - pipeline options
 * @param callbacks - optional progress callbacks
 */
export async function runPerSessionPipeline(
  sessions: SessionInfo[],
  storeDir: string,
  projectRoot: string,
  rulesSnapshot: RulesSnapshot,
  opts: PipelineOptions,
  callbacks?: PipelineCallbacks,
  existingResults?: AnalysisResult[],
): Promise<PipelineResult> {
  const accumulator: PipelineAccumulator = {
    analysisResults: [],
    suggestions: [],
    insightIds: [],
    crossPatternIds: [],
  };

  const sessionResults: SessionPipelineResult[] = [];
  const promptVersion = await getPromptVersion('session-analysis');
  let totalAnalysisTimeMs = 0;
  let totalSuggestTimeMs = 0;

  const hasExisting = (existingResults?.length ?? 0) > 0;

  if (sessions.length === 0 && !hasExisting) {
    return buildResult(sessionResults, [], [], accumulator, {
      totalAnalysisTimeMs: 0,
      totalSuggestTimeMs: 0,
    });
  }

  // Dry run: report what would be processed, no LLM calls
  if (opts.dryRun) {
    for (const session of sessions) {
      sessionResults.push({
        sessionId: session.sessionId,
        insights: [],
        suggestions: [],
        analysisTimeMs: 0,
        suggestTimeMs: 0,
      });
      callbacks?.onSessionComplete?.({
        sessionId: session.sessionId,
        insights: [],
        suggestions: [],
        analysisTimeMs: 0,
        suggestTimeMs: 0,
      });
    }
    return buildResult(sessionResults, [], [], accumulator, {
      totalAnalysisTimeMs: 0,
      totalSuggestTimeMs: 0,
    });
  }

  // Phase 1: Start parallel combined tasks (analyze+suggest per session, up to 3 concurrent)
  // Each promise resolves individually as its combined call completes.
  const combinedTasks = sessions.map((session) => async (): Promise<CombinedTaskResult | null> => {
    callbacks?.onSessionAnalyzing?.(session.sessionId, session.userMessageCount);

    try {
      const { analysisResult, suggestions: rawSuggestions } = await analyzeAndSuggestSession(
        session,
        rulesSnapshot,
        opts.verbose,
        opts.model as ModelName | undefined,
      );

      // Save result and update audit
      await saveAnalysisResult(storeDir, analysisResult);
      let audit = await loadAuditLog(storeDir);
      audit = markSessionAnalyzed(audit, session.sessionId, promptVersion, analysisResult.insights.length);
      await saveAuditLog(storeDir, audit);

      callbacks?.onSessionAnalyzed?.(session.sessionId, analysisResult.insights.length, analysisResult.stats.analysisTimeMs);

      return { analysisResult, rawSuggestions };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const warning = `Analysis failed for ${session.sessionId.slice(0, 8)}: ${msg}`;
      if (callbacks?.onWarning) {
        callbacks.onWarning(warning);
      } else {
        printWarning(warning);
      }
      return null;
    }
  });

  const combinedPromises = startWithConcurrency(combinedTasks, ANALYSIS_CONCURRENCY);

  // Process existing analysis results first (already-analyzed sessions, suggest-only)
  if (existingResults && existingResults.length > 0) {
    for (const existing of existingResults) {
      accumulator.analysisResults.push(existing);
      accumulator.insightIds.push(...existing.insights.map((i) => i.id));

      const result = await suggestForExistingResult(existing, rulesSnapshot, accumulator, opts, callbacks);
      totalSuggestTimeMs += result.suggestTimeMs;
      sessionResults.push(result);
      callbacks?.onSessionComplete?.(result);
    }
  }

  // Phase 2: Await each combined result in session order, dedup immediately.
  // When we await combinedPromises[i], tasks i+1..N continue in the background.
  for (let i = 0; i < sessions.length; i++) {
    const resultOrError = await combinedPromises[i];

    // Skip failed tasks
    if (resultOrError instanceof Error || resultOrError === null) {
      sessionResults.push({
        sessionId: sessions[i].sessionId,
        insights: [],
        suggestions: [],
        analysisTimeMs: 0,
        suggestTimeMs: 0,
      });
      continue;
    }

    const { analysisResult, rawSuggestions } = resultOrError;
    totalAnalysisTimeMs += analysisResult.stats.analysisTimeMs;

    accumulator.analysisResults.push(analysisResult);
    accumulator.insightIds.push(...analysisResult.insights.map((i) => i.id));

    // Convert raw LLM suggestions to full Suggestion objects and dedup
    const newSuggestions = processSuggestionsFromCombined(
      rawSuggestions,
      analysisResult,
      rulesSnapshot,
      accumulator,
    );

    sessionResults.push({
      sessionId: analysisResult.sessionId,
      insights: analysisResult.insights,
      suggestions: newSuggestions,
      analysisTimeMs: analysisResult.stats.analysisTimeMs,
      suggestTimeMs: 0, // combined call — no separate suggest time
    });
    callbacks?.onSessionComplete?.({
      sessionId: analysisResult.sessionId,
      insights: analysisResult.insights,
      suggestions: newSuggestions,
      analysisTimeMs: analysisResult.stats.analysisTimeMs,
      suggestTimeMs: 0,
    });
  }

  // Phase 3: Cross-session synthesis
  let crossPatterns: CrossSessionPattern[] = [];
  let crossSuggestions: Suggestion[] = [];

  if (
    !opts.noCross &&
    accumulator.analysisResults.length >= 2 &&
    accumulator.insightIds.length > 0
  ) {
    try {
      if (opts.verbose) {
        printVerbose(`Cross-session synthesis (${accumulator.insightIds.length} insights from ${accumulator.analysisResults.length} sessions)...`);
      }

      crossPatterns = await synthesizeCrossSessions(
        accumulator.analysisResults,
        projectRoot,
        opts.verbose,
        opts.model as ModelName | undefined,
      );

      if (crossPatterns.length > 0) {
        await saveCrossSessionPatterns(storeDir, crossPatterns);
        let audit = await loadAuditLog(storeDir);
        audit = markCrossSessionDone(audit);
        await saveAuditLog(storeDir, audit);

        accumulator.crossPatternIds.push(...crossPatterns.map((p) => p.id));

        // Generate suggestions for cross-session patterns
        const crossInsights = crossPatterns.map((p) => ({
          id: p.id,
          category: p.category,
          confidence: p.confidence,
          title: p.title,
          description: p.description,
          evidence: [],
          suggestedRule: p.suggestedRule,
          actionHint: p.actionHint,
          sessionId: p.occurrences[0]?.sessionId ?? '',
          projectPath: p.projectPath,
        }));

        const crossGenResult = await generateSessionSuggestions(
          crossInsights,
          rulesSnapshot,
          accumulator.suggestions,
          opts.verbose,
          opts.model as ModelName | undefined,
        );

        const prevIds = new Set(accumulator.suggestions.map((s) => s.id));
        const merged = [...accumulator.suggestions, ...crossGenResult.suggestions];
        accumulator.suggestions = dedupAndRank(merged);
        crossSuggestions = accumulator.suggestions.filter((s) => !prevIds.has(s.id));

        totalSuggestTimeMs += crossGenResult.durationMs;
      }

      callbacks?.onCrossSessionComplete?.(crossPatterns, crossSuggestions);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const warning = `Cross-session synthesis failed: ${msg}`;
      if (callbacks?.onWarning) {
        callbacks.onWarning(warning);
      } else {
        printWarning(warning);
      }
    }
  }

  // Save final suggestion set
  if (accumulator.suggestions.length > 0) {
    const stats = buildSuggestionStats(accumulator.suggestions, rulesSnapshot);
    const suggestionSet: SuggestionSet = {
      projectPath: projectRoot,
      generatedAt: new Date().toISOString(),
      suggestions: accumulator.suggestions,
      stats,
    };
    await saveSuggestionSet(storeDir, suggestionSet);
  }

  return buildResult(sessionResults, crossPatterns, crossSuggestions, accumulator, {
    totalAnalysisTimeMs,
    totalSuggestTimeMs,
  });
}

/**
 * Convert raw LLM suggestions from combined call into full Suggestion objects,
 * then merge with accumulator and dedup.
 */
function processSuggestionsFromCombined(
  rawSuggestions: LlmSuggestion[],
  analysisResult: AnalysisResult,
  rulesSnapshot: RulesSnapshot,
  accumulator: PipelineAccumulator,
): Suggestion[] {
  if (rawSuggestions.length === 0) return [];

  const insightSessionMap = buildInsightSessionMap(analysisResult.insights, []);
  const builtSuggestions: Suggestion[] = [];

  for (const raw of rawSuggestions) {
    if (raw.skipped) continue;
    const suggestion = buildSuggestion(raw, rulesSnapshot, insightSessionMap);
    if (suggestion) {
      builtSuggestions.push(suggestion);
    }
  }

  if (builtSuggestions.length === 0) return [];

  // Incremental dedup: merge with accumulator
  const prevIds = new Set(accumulator.suggestions.map((s) => s.id));
  const merged = [...accumulator.suggestions, ...builtSuggestions];
  accumulator.suggestions = dedupAndRank(merged);
  return accumulator.suggestions.filter((s) => !prevIds.has(s.id));
}

/**
 * Generate suggestions for an already-analyzed session (suggest-only, separate LLM call).
 * Used for existingResults that were analyzed in a prior run.
 */
async function suggestForExistingResult(
  analysisResult: AnalysisResult,
  rulesSnapshot: RulesSnapshot,
  accumulator: PipelineAccumulator,
  opts: PipelineOptions,
  callbacks?: PipelineCallbacks,
): Promise<SessionPipelineResult> {
  let newSuggestions: Suggestion[] = [];
  let suggestTimeMs = 0;

  if (analysisResult.insights.length > 0) {
    try {
      const suggestStart = Date.now();
      const genResult = await generateSessionSuggestions(
        analysisResult.insights,
        rulesSnapshot,
        accumulator.suggestions,
        opts.verbose,
        opts.model as ModelName | undefined,
      );
      suggestTimeMs = Date.now() - suggestStart;

      // Incremental dedup
      const prevIds = new Set(accumulator.suggestions.map((s) => s.id));
      const merged = [...accumulator.suggestions, ...genResult.suggestions];
      accumulator.suggestions = dedupAndRank(merged);
      newSuggestions = accumulator.suggestions.filter((s) => !prevIds.has(s.id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const warning = `Suggestion generation failed for ${analysisResult.sessionId.slice(0, 8)}: ${msg}`;
      if (callbacks?.onWarning) {
        callbacks.onWarning(warning);
      } else {
        printWarning(warning);
      }
    }
  }

  return {
    sessionId: analysisResult.sessionId,
    insights: analysisResult.insights,
    suggestions: newSuggestions,
    analysisTimeMs: analysisResult.stats.analysisTimeMs,
    suggestTimeMs,
  };
}

function buildResult(
  sessionResults: SessionPipelineResult[],
  crossPatterns: CrossSessionPattern[],
  crossSuggestions: Suggestion[],
  accumulator: PipelineAccumulator,
  timing: { totalAnalysisTimeMs: number; totalSuggestTimeMs: number },
): PipelineResult {
  return {
    sessionResults,
    crossPatterns,
    crossSuggestions,
    allSuggestions: accumulator.suggestions,
    stats: {
      sessionsAnalyzed: accumulator.analysisResults.length,
      insightsFound: accumulator.insightIds.length,
      crossPatternsFound: accumulator.crossPatternIds.length,
      suggestionsGenerated: accumulator.suggestions.length,
      totalAnalysisTimeMs: timing.totalAnalysisTimeMs,
      totalSuggestTimeMs: timing.totalSuggestTimeMs,
    },
  };
}

function buildSuggestionStats(
  suggestions: Suggestion[],
  rulesSnapshot: RulesSnapshot,
): SuggestionStats {
  return {
    total: suggestions.length,
    byType: {
      add: suggestions.filter((s) => s.type === 'add').length,
      update: suggestions.filter((s) => s.type === 'update').length,
      remove: suggestions.filter((s) => s.type === 'remove').length,
      consolidate: suggestions.filter((s) => s.type === 'consolidate').length,
      split: suggestions.filter((s) => s.type === 'split').length,
    },
    byPriority: {
      high: suggestions.filter((s) => s.priority === 'high').length,
      medium: suggestions.filter((s) => s.priority === 'medium').length,
      low: suggestions.filter((s) => s.priority === 'low').length,
    },
    insightsUsed: suggestions.length,
    insightsSkipped: 0,
    estimatedRulesAfter: rulesSnapshot.stats.totalRules + suggestions.filter((s) => s.type === 'add').length,
  };
}
