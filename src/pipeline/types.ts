import type { Insight, AnalysisResult, CrossSessionPattern } from '../analyzer/types.js';
import type { Suggestion } from '../suggester/types.js';
import type { ModelName } from '../analyzer/llm-client.js';

export interface PipelineOptions {
  verbose: boolean;
  model?: ModelName;
  noCross: boolean;
  dryRun: boolean;
  force: boolean;
  minMessages: number;
  yes: boolean;
}

export interface PipelineCallbacks {
  /** Called after each session is analyzed and suggestions are generated. */
  onSessionComplete?: (result: SessionPipelineResult) => void;
  /** Called after cross-session synthesis completes. */
  onCrossSessionComplete?: (patterns: CrossSessionPattern[], suggestions: Suggestion[]) => void;
  /** Called when analysis starts for a session (for progress display). */
  onSessionAnalyzing?: (sessionId: string, userMessageCount: number) => void;
  /** Called when analysis finishes for a session (before suggest starts). */
  onSessionAnalyzed?: (sessionId: string, insightsFound: number, analysisTimeMs: number) => void;
  /** Called when a non-fatal warning occurs (e.g., suggest failure). Replaces printWarning in JSON mode. */
  onWarning?: (message: string) => void;
}

export interface SessionPipelineResult {
  sessionId: string;
  insights: Insight[];
  /** New suggestions generated for this session (after dedup against accumulated). */
  suggestions: Suggestion[];
  analysisTimeMs: number;
  suggestTimeMs: number;
}

export interface PipelineResult {
  sessionResults: SessionPipelineResult[];
  crossPatterns: CrossSessionPattern[];
  crossSuggestions: Suggestion[];
  /** Final deduped set of all suggestions across all sessions + cross-session. */
  allSuggestions: Suggestion[];
  stats: PipelineStats;
}

export interface PipelineStats {
  sessionsAnalyzed: number;
  insightsFound: number;
  crossPatternsFound: number;
  suggestionsGenerated: number;
  totalAnalysisTimeMs: number;
  totalSuggestTimeMs: number;
}

export interface PipelineAccumulator {
  /** Analysis results from all processed sessions (for cross-session synthesis). */
  analysisResults: AnalysisResult[];
  /** All suggestions generated so far (deduped after each session). */
  suggestions: Suggestion[];
  /** All insight IDs generated in this run. */
  insightIds: string[];
  /** All cross-pattern IDs generated in this run. */
  crossPatternIds: string[];
}
