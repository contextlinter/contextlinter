import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type {
  ContentBlock,
  NormalizedMessage,
  RawSessionLine,
  SessionFileInfo,
  SessionInfo,
  ToolResultInfo,
  ToolUseInfo,
} from './types.js';

const TOOL_RESULT_MAX_LENGTH = 500;

/**
 * Parse a single JSONL line into a RawSessionLine.
 * Returns null if the line is not valid JSON.
 */
export function parseJsonLine(line: string): RawSessionLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!('type' in parsed) || typeof (parsed as Record<string, unknown>).type !== 'string') return null;
    return parsed as RawSessionLine;
  } catch {
    return null;
  }
}

/**
 * Normalize the `role` field to our known set.
 */
function normalizeRole(rawType: string, role?: string): NormalizedMessage['role'] {
  if (rawType === 'user' || role === 'user') return 'user';
  if (rawType === 'assistant' || role === 'assistant') return 'assistant';
  if (rawType === 'system' || role === 'system') return 'system';
  return 'unknown';
}

/**
 * Extract text content from a content field that can be a string or array of blocks.
 */
export function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;

  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('\n');
}

/**
 * Extract tool use info from content blocks.
 */
export function extractToolUses(content: string | ContentBlock[]): ToolUseInfo[] {
  if (typeof content === 'string') return [];

  return content
    .filter((block) => block.type === 'tool_use' && typeof block.name === 'string')
    .map((block) => ({
      id: block.id ?? '',
      name: block.name!,
      input: block.input,
    }));
}

/**
 * Extract tool result info from content blocks, truncating long content.
 */
export function extractToolResults(content: string | ContentBlock[]): ToolResultInfo[] {
  if (typeof content === 'string') return [];

  return content
    .filter((block) => block.type === 'tool_result')
    .map((block) => ({
      toolUseId: block.tool_use_id ?? '',
      content: truncateContent(block.content),
    }));
}

function truncateContent(content: unknown): string {
  const str = typeof content === 'string'
    ? content
    : JSON.stringify(content) ?? '';
  if (str.length <= TOOL_RESULT_MAX_LENGTH) return str;
  return str.slice(0, TOOL_RESULT_MAX_LENGTH) + '...';
}

/**
 * Check whether any content block contains thinking.
 */
export function hasThinkingBlock(content: string | ContentBlock[]): boolean {
  if (typeof content === 'string') return false;
  return content.some((block) => block.type === 'thinking');
}

/**
 * Normalize a raw JSONL line into a NormalizedMessage.
 * Returns null for lines that don't represent messages (e.g. summary lines).
 */
export function normalizeLine(raw: RawSessionLine): NormalizedMessage | null {
  if (raw.type === 'summary') return null;

  const message = raw.message;
  const content = message?.content ?? '';

  return {
    role: normalizeRole(raw.type, message?.role),
    timestamp: raw.timestamp ?? null,
    textContent: extractTextContent(content),
    toolUses: extractToolUses(content),
    toolResults: extractToolResults(content),
    hasThinking: hasThinkingBlock(content),
    rawType: raw.type,
  };
}

export interface ParseWarning {
  lineNumber: number;
  error: string;
}

export interface ParseResult {
  messages: NormalizedMessage[];
  summary: string | null;
  warnings: ParseWarning[];
  lineCount: number;
}

/**
 * Parse a JSONL session file by streaming line-by-line.
 * Never loads the entire file into memory.
 */
export async function parseSessionFile(filePath: string): Promise<ParseResult> {
  const messages: NormalizedMessage[] = [];
  const warnings: ParseWarning[] = [];
  let summary: string | null = null;
  let lineNumber = 0;

  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineNumber++;

    const raw = parseJsonLine(line);
    if (!raw) {
      if (line.trim()) {
        warnings.push({ lineNumber, error: 'Invalid JSON' });
      }
      continue;
    }

    if (raw.type === 'summary' && typeof raw.summary === 'string') {
      summary = raw.summary;
    }

    const normalized = normalizeLine(raw);
    if (normalized) {
      messages.push(normalized);
    }
  }

  return { messages, summary, warnings, lineCount: lineNumber };
}

/**
 * Build a full SessionInfo from a SessionFileInfo by parsing the file.
 */
export async function buildSessionInfo(
  sessionFile: SessionFileInfo,
  projectPath: string,
  projectPathEncoded: string,
): Promise<SessionInfo> {
  const { messages, summary, warnings, lineCount } = await parseSessionFile(
    sessionFile.filePath,
  );

  const userMessages = messages.filter((m) => m.role === 'user');
  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const toolUseCount = messages.reduce((sum, m) => sum + m.toolUses.length, 0);

  const timestamps = messages
    .map((m) => m.timestamp)
    .filter((t): t is string => t !== null)
    .sort();

  const firstTimestamp = timestamps[0] ?? null;
  const lastTimestamp = timestamps[timestamps.length - 1] ?? null;

  let durationMinutes: number | null = null;
  if (firstTimestamp && lastTimestamp) {
    const start = new Date(firstTimestamp).getTime();
    const end = new Date(lastTimestamp).getTime();
    if (!isNaN(start) && !isNaN(end)) {
      durationMinutes = Math.round((end - start) / 60_000);
    }
  }

  return {
    sessionId: sessionFile.sessionId,
    projectPath,
    projectPathEncoded,
    filePath: sessionFile.filePath,
    fileSize: sessionFile.fileSize,
    messageCount: lineCount,
    userMessageCount: userMessages.length,
    assistantMessageCount: assistantMessages.length,
    toolUseCount,
    firstTimestamp,
    lastTimestamp,
    durationMinutes,
    summary,
    messages,
  };
}
