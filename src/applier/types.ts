export type ApplyAction = 'accept' | 'reject' | 'edit' | 'skip' | 'quit';

export interface ApplyResult {
  suggestionId: string;
  action: ApplyAction;
  editedContent: string | null;
  appliedAt: string | null;
}

export interface ApplySession {
  startedAt: string;
  completedAt: string;
  projectPath: string;
  results: ApplyResult[];
  filesModified: string[];
  filesCreated: string[];
  rulesAdded: number;
  rulesUpdated: number;
  rulesRemoved: number;
  rulesSplit: number;
}

export interface RulesHistoryEntry {
  timestamp: string;
  action: 'add' | 'update' | 'remove' | 'consolidate' | 'split';
  file: string;
  section: string | null;
  content: string;
  previousContent: string | null;
  reason: string;
  sourceInsightIds: string[];
  sourceSessionIds: string[];
  confidence: number;
}

export interface ApplyOptions {
  project?: string;
  all?: boolean;
  verbose: boolean;
  yes: boolean;
  dryRun: boolean;
  minConfidence?: number;
  limit?: number;
  full: boolean;
  model?: string;
}
