// === Raw types (directly from JSONL) ===

export interface RawSessionLine {
  type: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  summary?: string;
  timestamp?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

// === Normalized types (session reader output) ===

export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  projectPathEncoded: string;
  filePath: string;
  fileSize: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolUseCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  durationMinutes: number | null;
  summary: string | null;
  messages: NormalizedMessage[];
}

export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'system' | 'unknown';
  timestamp: string | null;
  textContent: string;
  toolUses: ToolUseInfo[];
  toolResults: ToolResultInfo[];
  hasThinking: boolean;
  rawType: string;
}

export interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultInfo {
  toolUseId: string;
  content: string;
}

// === Discovery types ===

export interface ProjectInfo {
  projectPath: string;
  projectPathEncoded: string;
  dirPath: string;
  sessions: SessionFileInfo[];
}

export interface SessionFileInfo {
  sessionId: string;
  filePath: string;
  fileSize: number;
  modifiedAt: Date;
  createdAt: Date | null;
}

// === CLI options ===

export interface CLIOptions {
  project?: string;
  all?: boolean;
  session?: string;
  verbose: boolean;
  limit?: number;
  days?: number;
}
