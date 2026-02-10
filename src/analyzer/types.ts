export type InsightCategory =
  | 'missing_project_knowledge'
  | 'repeated_correction'
  | 'rejected_approach'
  | 'intent_clarification'
  | 'convention_establishment'
  | 'tool_command_correction'
  | 'tool_usage_pattern';

export type InsightActionHint =
  | 'add_to_rules'
  | 'update_rules'
  | 'add_to_global_rules'
  | 'prompt_improvement'
  | 'unclear';

export interface Insight {
  id: string;
  category: InsightCategory;
  confidence: number;
  title: string;
  description: string;
  evidence: Evidence[];
  suggestedRule: string | null;
  actionHint: InsightActionHint;
  sessionId: string;
  projectPath: string;
}

export interface Evidence {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
  messageIndex: number;
}

export interface AnalysisResult {
  sessionId: string;
  projectPath: string;
  analyzedAt: string;
  insights: Insight[];
  stats: AnalysisStats;
}

export interface AnalysisStats {
  totalMessages: number;
  userMessages: number;
  correctionsDetected: number;
  insightsGenerated: number;
  analysisTimeMs: number;
  tokensUsed: number | null;
}

export interface ToolUsageSummary {
  totalToolCalls: number;
  byTool: Record<string, {
    count: number;
    failures: number;
  }>;
  repeatedFileAccess: {
    filePath: string;
    readCount: number;
    writeCount: number;
  }[];
  bashFailureRate: number;
}

export interface PreparedSession {
  sessionId: string;
  projectPath: string;
  toolUsageSummary: ToolUsageSummary;
  messages: PreparedMessage[];
  totalMessagesBeforeFilter: number;
  totalMessagesAfterFilter: number;
  wasSampled: boolean;
  estimatedTokens: number;
}

export interface PreparedMessage {
  role: 'user' | 'assistant';
  text: string;
  toolNames: string[];
  timestamp: string | null;
  originalIndex: number;
}

export interface CrossSessionPattern {
  id: string;
  category: InsightCategory;
  confidence: number;
  title: string;
  description: string;
  occurrences: PatternOccurrence[];
  suggestedRule: string | null;
  actionHint: InsightActionHint;
  projectPath: string;
}

export interface PatternOccurrence {
  sessionId: string;
  insightId: string;
  timestamp: string | null;
}

export interface AuditLog {
  sessions: Record<string, {
    parsedAt: string;
    analyzedAt: string | null;
    analysisPromptVersion: string;
    insightCount: number;
    sessionMtime: number;
  }>;
  lastCrossSessionAt: string | null;
  version: number;
}

export interface LlmCallResult {
  raw: string;
  parsed: unknown;
  durationMs: number;
  estimatedTokens: number;
}

export interface AnalyzeOptions {
  project?: string;
  all?: boolean;
  limit?: number;
  force: boolean;
  verbose: boolean;
  noCross: boolean;
  dryRun: boolean;
  yes: boolean;
  model?: string;
  minMessages?: number;
}
