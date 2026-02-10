export type SuggestionType = 'add' | 'update' | 'remove' | 'consolidate' | 'split';

export type SuggestionPriority = 'high' | 'medium' | 'low';

export interface Suggestion {
  id: string;
  type: SuggestionType;
  priority: SuggestionPriority;
  confidence: number;
  title: string;
  rationale: string;

  // Where
  targetFile: string;
  targetSection: string | null;

  // What
  diff: SuggestionDiff;

  // Origin
  sourceInsightIds: string[];
  sourceSessionIds: string[];

  // For split: destination file path
  splitTarget: string | null;

  // Status (for interactive apply in step 05)
  status: 'pending' | 'accepted' | 'rejected' | 'applied';
}

export interface SuggestionDiff {
  type: 'add' | 'replace' | 'remove';

  // For add: where to insert
  afterLine: number | null;
  inSection: string | null;

  // For replace/remove: what to remove
  removedLines: DiffLine[] | null;

  // For add/replace: what to insert
  addedLines: DiffLine[] | null;

  // For consolidate: multiple changes
  parts: SuggestionDiff[] | null;
}

export interface DiffLine {
  lineNumber: number | null;
  content: string;
}

export interface SuggestionSet {
  projectPath: string;
  generatedAt: string;
  suggestions: Suggestion[];
  stats: SuggestionStats;
  /** Hash of insight IDs + rules content + prompt version. Used to skip LLM when unchanged. */
  cacheKey?: string;
}

export interface SuggestionStats {
  total: number;
  byType: Record<SuggestionType, number>;
  byPriority: Record<SuggestionPriority, number>;
  insightsUsed: number;
  insightsSkipped: number;
  estimatedRulesAfter: number;
}

/** Raw suggestion shape returned by the LLM */
export interface LlmSuggestion {
  type: SuggestionType;
  targetFile: string;
  targetSection: string | null;
  title: string;
  rationale: string;
  priority: SuggestionPriority;
  content: {
    add: string | string[] | null;
    remove: string | string[] | null;
  };
  insightIds: string[];
  skipped: boolean;
  skipReason: string | null;
}

export interface SuggestOptions {
  project?: string;
  all?: boolean;
  verbose: boolean;
  full: boolean;
  limit?: number;
  model?: string;
  /** When set, only process these insight/pattern IDs (used by `run` pipeline). */
  scopedInsightIds?: string[];
}
