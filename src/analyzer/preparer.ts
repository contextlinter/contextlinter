import type { NormalizedMessage, SessionInfo } from '../session-reader/types.js';
import type { PreparedMessage, PreparedSession, ToolUsageSummary } from './types.js';

const MAX_MESSAGE_LENGTH = 500;
const MAX_MESSAGES_BEFORE_SAMPLING = 150;
const SAMPLE_HEAD_EXCHANGES = 10;
const SAMPLE_TAIL_EXCHANGES = 10;
const SAMPLE_MIDDLE_EXCHANGES = 10;
const PROMPT_TEMPLATE_OVERHEAD_CHARS = 3000;
const CHARS_PER_TOKEN = 4;
const REPEATED_FILE_THRESHOLD = 5;

/** Types to filter out — metadata, not conversation. */
const FILTERED_TYPES = new Set([
  'file-history-snapshot',
  'queue-operation',
  'pr-link',
  'progress',
]);

/** Types that represent actual conversation messages. */
const CONVERSATION_ROLES = new Set<string>(['user', 'assistant']);

/**
 * Prepare a session for LLM analysis: filter, aggregate tool usage, truncate, sample.
 */
export function prepareSession(session: SessionInfo): PreparedSession {
  const toolUsageSummary = aggregateToolUsage(session.messages);
  const totalMessagesBeforeFilter = session.messages.length;

  // Step 1: Filter to conversation messages only
  const conversationMessages = session.messages.filter(
    (m) => CONVERSATION_ROLES.has(m.role) && !FILTERED_TYPES.has(m.rawType),
  );

  // Step 2: Convert to PreparedMessages (truncate text, extract tool names)
  let prepared = conversationMessages.map((m, idx) => toPreparedMessage(m, idx));

  // Step 3: Filter out empty messages (no text and no tools)
  prepared = prepared.filter((m) => m.text.length > 0 || m.toolNames.length > 0);

  const totalMessagesAfterFilter = prepared.length;

  // Step 4: Sample if too many messages
  let wasSampled = false;
  if (prepared.length > MAX_MESSAGES_BEFORE_SAMPLING) {
    prepared = sampleMessages(prepared);
    wasSampled = true;
  }

  // Step 5: Estimate tokens and check limit
  const estimatedTokens = estimateTokens(prepared, toolUsageSummary);

  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    toolUsageSummary,
    messages: prepared,
    totalMessagesBeforeFilter,
    totalMessagesAfterFilter,
    wasSampled,
    estimatedTokens,
  };
}

function toPreparedMessage(msg: NormalizedMessage, index: number): PreparedMessage {
  return {
    role: msg.role as 'user' | 'assistant',
    text: truncateText(msg.textContent, MAX_MESSAGE_LENGTH),
    toolNames: msg.toolUses.map((t) => t.name),
    timestamp: msg.timestamp,
    originalIndex: index,
  };
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

/**
 * Group messages into exchanges (user→assistant pairs).
 * Consecutive messages of the same role get grouped into the same exchange.
 */
function groupIntoExchanges(messages: PreparedMessage[]): PreparedMessage[][] {
  const exchanges: PreparedMessage[][] = [];
  let current: PreparedMessage[] = [];

  for (const msg of messages) {
    if (current.length > 0 && msg.role === 'user' && current[current.length - 1].role === 'assistant') {
      exchanges.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) exchanges.push(current);

  return exchanges;
}

/**
 * Sample by exchanges (user→assistant pairs), not individual messages.
 * Takes first N, last N, random N exchanges from the middle.
 */
function sampleMessages(messages: PreparedMessage[]): PreparedMessage[] {
  const exchanges = groupIntoExchanges(messages);

  if (exchanges.length <= SAMPLE_HEAD_EXCHANGES + SAMPLE_TAIL_EXCHANGES + SAMPLE_MIDDLE_EXCHANGES) {
    return messages;
  }

  const head = exchanges.slice(0, SAMPLE_HEAD_EXCHANGES);
  const tail = exchanges.slice(-SAMPLE_TAIL_EXCHANGES);
  const middlePool = exchanges.slice(SAMPLE_HEAD_EXCHANGES, -SAMPLE_TAIL_EXCHANGES);

  const middleSample = pickRandom(middlePool, SAMPLE_MIDDLE_EXCHANGES);
  middleSample.sort((a, b) => a[0].originalIndex - b[0].originalIndex);

  const skippedExchanges = middlePool.length - middleSample.length;
  const skippedMsgs = middlePool
    .filter((ex) => !middleSample.includes(ex))
    .reduce((sum, ex) => sum + ex.length, 0);

  const skipMarker: PreparedMessage = {
    role: 'assistant',
    text: `[...skipped ${skippedMsgs} messages from ${skippedExchanges} exchanges...]`,
    toolNames: [],
    timestamp: null,
    originalIndex: -1,
  };

  return [
    ...head.flat(),
    skipMarker,
    ...middleSample.flat(),
    skipMarker,
    ...tail.flat(),
  ];
}

function pickRandom<T>(arr: T[], count: number): T[] {
  if (arr.length <= count) return [...arr];
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0 && i >= shuffled.length - count; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(-count);
}

/**
 * Aggregate tool usage statistics from all messages (including progress lines).
 */
export function aggregateToolUsage(messages: NormalizedMessage[]): ToolUsageSummary {
  const byTool: Record<string, { count: number; failures: number }> = {};
  const fileAccess: Record<string, { readCount: number; writeCount: number }> = {};
  let totalToolCalls = 0;
  let bashTotal = 0;
  let bashFailures = 0;

  for (const msg of messages) {
    for (const tool of msg.toolUses) {
      totalToolCalls++;
      const name = tool.name;

      if (!byTool[name]) {
        byTool[name] = { count: 0, failures: 0 };
      }
      byTool[name].count++;

      // Track file access
      const input = tool.input as Record<string, unknown> | null;
      if (input && typeof input === 'object') {
        const filePath = input.file_path as string | undefined;
        if (filePath && (name === 'Read' || name === 'Write' || name === 'Edit')) {
          if (!fileAccess[filePath]) {
            fileAccess[filePath] = { readCount: 0, writeCount: 0 };
          }
          if (name === 'Read') {
            fileAccess[filePath].readCount++;
          } else {
            fileAccess[filePath].writeCount++;
          }
        }

        // Track Bash failures from tool results
        if (name === 'Bash') {
          bashTotal++;
        }
      }
    }

    // Check tool results for Bash failures (non-zero exit, error indicators)
    for (const result of msg.toolResults) {
      if (result.content.includes('exit code') || result.content.includes('Error') || result.content.includes('error:')) {
        // Find which tool this result belongs to
        const matchingTool = msg.toolUses.find((t) => t.id === result.toolUseId);
        if (matchingTool) {
          const entry = byTool[matchingTool.name];
          if (entry) entry.failures++;
          if (matchingTool.name === 'Bash') bashFailures++;
        }
      }
    }
  }

  const repeatedFileAccess = Object.entries(fileAccess)
    .filter(([_, counts]) => counts.readCount + counts.writeCount >= REPEATED_FILE_THRESHOLD)
    .map(([filePath, counts]) => ({ filePath, ...counts }))
    .sort((a, b) => (b.readCount + b.writeCount) - (a.readCount + a.writeCount));

  return {
    totalToolCalls,
    byTool,
    repeatedFileAccess,
    bashFailureRate: bashTotal > 0 ? bashFailures / bashTotal : 0,
  };
}

/**
 * Estimate token count for the full prompt sent to the LLM (1 token ~ 4 chars).
 * Includes prompt template overhead, tool usage summary, and conversation.
 */
function estimateTokens(messages: PreparedMessage[], toolUsage: ToolUsageSummary): number {
  let totalChars = PROMPT_TEMPLATE_OVERHEAD_CHARS;
  totalChars += JSON.stringify(toolUsage).length;
  for (const msg of messages) {
    totalChars += msg.text.length + msg.toolNames.join(', ').length + 20;
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Format a prepared session as text for the LLM prompt.
 */
export function formatToolUsageSummary(summary: ToolUsageSummary): string {
  const lines: string[] = [];
  lines.push(`Total tool calls: ${summary.totalToolCalls}`);

  const sortedTools = Object.entries(summary.byTool)
    .sort(([, a], [, b]) => b.count - a.count);

  for (const [name, stats] of sortedTools) {
    const failStr = stats.failures > 0 ? ` (${stats.failures} failures)` : '';
    lines.push(`  ${name}: ${stats.count}${failStr}`);
  }

  if (summary.bashFailureRate > 0) {
    lines.push(`Bash failure rate: ${(summary.bashFailureRate * 100).toFixed(0)}%`);
  }

  if (summary.repeatedFileAccess.length > 0) {
    lines.push('');
    lines.push('Frequently accessed files:');
    for (const f of summary.repeatedFileAccess) {
      lines.push(`  ${f.filePath}: ${f.readCount} reads, ${f.writeCount} writes`);
    }
  }

  return lines.join('\n');
}

/**
 * Format prepared messages as conversation text for the LLM prompt.
 */
export function formatConversation(messages: PreparedMessage[]): string {
  return messages.map((m) => {
    const toolStr = m.toolNames.length > 0 ? ` [tools: ${m.toolNames.join(', ')}]` : '';
    return `[${m.role.toUpperCase()}]${toolStr}\n${m.text}`;
  }).join('\n\n');
}

/**
 * Check if a session has enough user messages to be worth analyzing.
 */
export function isSessionAnalyzable(session: SessionInfo, minMessages = 2): boolean {
  return session.userMessageCount >= minMessages;
}
