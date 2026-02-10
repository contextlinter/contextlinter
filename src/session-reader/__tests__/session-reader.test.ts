import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { statSync } from 'node:fs';
import {
  parseJsonLine,
  normalizeLine,
  extractTextContent,
  extractToolUses,
  extractToolResults,
  hasThinkingBlock,
  parseSessionFile,
  buildSessionInfo,
} from '../parser.js';
import type { RawSessionLine, SessionFileInfo } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = join(tmpdir(), `session-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

/** Write a JSONL string to a temp file and return the path. */
function writeTmpJsonl(content: string): string {
  const dir = makeTmpDir();
  const filePath = join(dir, 'test-session.jsonl');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Realistic JSONL fixtures
// ---------------------------------------------------------------------------

const USER_LINE = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'How do I add dark mode?' },
  timestamp: '2025-04-10T14:00:00.000Z',
  session_id: 'abc-123',
});

const ASSISTANT_TEXT_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'You can add dark mode by using CSS variables.' },
    ],
  },
  timestamp: '2025-04-10T14:00:05.000Z',
});

const ASSISTANT_TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me read the file first.' },
      {
        type: 'tool_use',
        id: 'tu_01',
        name: 'Read',
        input: { file_path: '/src/theme.ts' },
      },
    ],
  },
  timestamp: '2025-04-10T14:00:10.000Z',
});

const ASSISTANT_TOOL_RESULT_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu_01',
        content: 'export const theme = { dark: false };',
      },
    ],
  },
  timestamp: '2025-04-10T14:00:11.000Z',
});

const ASSISTANT_THINKING_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'I should check the theme config...' },
      { type: 'text', text: 'Let me check your theme config.' },
    ],
  },
  timestamp: '2025-04-10T14:00:15.000Z',
});

const PROGRESS_LINE = JSON.stringify({
  type: 'progress',
  content: { type: 'text', text: 'Processing step 3 of 5...' },
  timestamp: '2025-04-10T14:00:20.000Z',
});

const FILE_HISTORY_SNAPSHOT_LINE = JSON.stringify({
  type: 'file-history-snapshot',
  files: [
    { path: '/src/theme.ts', hash: 'abc123' },
    { path: '/src/app.tsx', hash: 'def456' },
  ],
  timestamp: '2025-04-10T14:00:25.000Z',
});

const QUEUE_OPERATION_LINE = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  task_id: 'task_42',
  timestamp: '2025-04-10T14:00:30.000Z',
});

const SUMMARY_LINE = JSON.stringify({
  type: 'summary',
  summary: 'Added dark mode support using CSS variables.',
  timestamp: '2025-04-10T14:01:00.000Z',
});

const SYSTEM_LINE = JSON.stringify({
  type: 'system',
  message: { role: 'system', content: 'You are a helpful assistant.' },
  timestamp: '2025-04-10T13:59:00.000Z',
});

// ---------------------------------------------------------------------------
// parseJsonLine
// ---------------------------------------------------------------------------

describe('parseJsonLine', () => {
  it('parses a valid user line', () => {
    const raw = parseJsonLine(USER_LINE);
    expect(raw).not.toBeNull();
    expect(raw!.type).toBe('user');
    expect(raw!.message?.role).toBe('user');
  });

  it('parses a valid assistant line', () => {
    const raw = parseJsonLine(ASSISTANT_TEXT_LINE);
    expect(raw).not.toBeNull();
    expect(raw!.type).toBe('assistant');
  });

  it('parses progress lines', () => {
    const raw = parseJsonLine(PROGRESS_LINE);
    expect(raw).not.toBeNull();
    expect(raw!.type).toBe('progress');
  });

  it('parses file-history-snapshot lines', () => {
    const raw = parseJsonLine(FILE_HISTORY_SNAPSHOT_LINE);
    expect(raw).not.toBeNull();
    expect(raw!.type).toBe('file-history-snapshot');
  });

  it('parses queue-operation lines', () => {
    const raw = parseJsonLine(QUEUE_OPERATION_LINE);
    expect(raw).not.toBeNull();
    expect(raw!.type).toBe('queue-operation');
  });

  it('returns null for empty string', () => {
    expect(parseJsonLine('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseJsonLine('   \t  ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseJsonLine('{not valid json')).toBeNull();
  });

  it('returns null for JSON without type field', () => {
    expect(parseJsonLine('{"message":"hello"}')).toBeNull();
  });

  it('returns null for JSON where type is not a string', () => {
    expect(parseJsonLine('{"type":42}')).toBeNull();
  });

  it('returns null for JSON array', () => {
    expect(parseJsonLine('[1,2,3]')).toBeNull();
  });

  it('returns null for JSON primitive', () => {
    expect(parseJsonLine('"hello"')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeLine
// ---------------------------------------------------------------------------

describe('normalizeLine', () => {
  it('normalizes a user message', () => {
    const raw = parseJsonLine(USER_LINE)!;
    const msg = normalizeLine(raw);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('user');
    expect(msg!.textContent).toBe('How do I add dark mode?');
    expect(msg!.rawType).toBe('user');
  });

  it('normalizes an assistant message with text blocks', () => {
    const raw = parseJsonLine(ASSISTANT_TEXT_LINE)!;
    const msg = normalizeLine(raw);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('assistant');
    expect(msg!.textContent).toBe('You can add dark mode by using CSS variables.');
  });

  it('returns null for summary lines', () => {
    const raw = parseJsonLine(SUMMARY_LINE)!;
    const msg = normalizeLine(raw);
    expect(msg).toBeNull();
  });

  it('normalizes progress lines as role unknown', () => {
    const raw = parseJsonLine(PROGRESS_LINE)!;
    const msg = normalizeLine(raw);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('unknown');
    expect(msg!.rawType).toBe('progress');
  });

  it('normalizes file-history-snapshot lines as role unknown', () => {
    const raw = parseJsonLine(FILE_HISTORY_SNAPSHOT_LINE)!;
    const msg = normalizeLine(raw);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('unknown');
    expect(msg!.rawType).toBe('file-history-snapshot');
  });

  it('normalizes queue-operation lines as role unknown', () => {
    const raw = parseJsonLine(QUEUE_OPERATION_LINE)!;
    const msg = normalizeLine(raw);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('unknown');
    expect(msg!.rawType).toBe('queue-operation');
  });

  it('normalizes system messages', () => {
    const raw = parseJsonLine(SYSTEM_LINE)!;
    const msg = normalizeLine(raw);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('system');
  });

  it('preserves timestamp', () => {
    const raw = parseJsonLine(USER_LINE)!;
    const msg = normalizeLine(raw);
    expect(msg!.timestamp).toBe('2025-04-10T14:00:00.000Z');
  });

  it('sets timestamp to null when absent', () => {
    const raw: RawSessionLine = { type: 'user', message: { role: 'user', content: 'hi' } };
    const msg = normalizeLine(raw);
    expect(msg!.timestamp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractTextContent
// ---------------------------------------------------------------------------

describe('extractTextContent', () => {
  it('returns string content as-is', () => {
    expect(extractTextContent('Hello world')).toBe('Hello world');
  });

  it('extracts text from text blocks', () => {
    const blocks = [
      { type: 'text', text: 'First paragraph.' },
      { type: 'text', text: 'Second paragraph.' },
    ];
    expect(extractTextContent(blocks)).toBe('First paragraph.\nSecond paragraph.');
  });

  it('ignores non-text blocks', () => {
    const blocks = [
      { type: 'thinking', thinking: 'Let me think...' },
      { type: 'text', text: 'Visible text.' },
      { type: 'tool_use', name: 'Read', id: 'tu_01' },
    ];
    expect(extractTextContent(blocks)).toBe('Visible text.');
  });

  it('returns empty string for empty array', () => {
    expect(extractTextContent([])).toBe('');
  });

  it('returns empty string for blocks with no text type', () => {
    const blocks = [{ type: 'tool_use', name: 'Bash', id: 'tu_02' }];
    expect(extractTextContent(blocks)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractToolUses
// ---------------------------------------------------------------------------

describe('extractToolUses', () => {
  it('extracts tool_use blocks with id, name, and input', () => {
    const raw = parseJsonLine(ASSISTANT_TOOL_USE_LINE)!;
    const content = raw.message!.content as import('../types.js').ContentBlock[];
    const tools = extractToolUses(content);
    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe('tu_01');
    expect(tools[0].name).toBe('Read');
    expect(tools[0].input).toEqual({ file_path: '/src/theme.ts' });
  });

  it('returns empty array for string content', () => {
    expect(extractToolUses('plain text')).toEqual([]);
  });

  it('returns empty array when no tool_use blocks exist', () => {
    const blocks = [{ type: 'text', text: 'hello' }];
    expect(extractToolUses(blocks)).toEqual([]);
  });

  it('extracts multiple tool uses', () => {
    const blocks = [
      { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} },
      { type: 'text', text: 'some text' },
      { type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'ls' } },
    ];
    const tools = extractToolUses(blocks);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('Read');
    expect(tools[1].name).toBe('Bash');
  });

  it('defaults id to empty string when missing', () => {
    const blocks = [{ type: 'tool_use', name: 'Glob' }];
    const tools = extractToolUses(blocks);
    expect(tools[0].id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractToolResults
// ---------------------------------------------------------------------------

describe('extractToolResults', () => {
  it('extracts tool_result blocks', () => {
    const raw = parseJsonLine(ASSISTANT_TOOL_RESULT_LINE)!;
    const content = raw.message!.content as import('../types.js').ContentBlock[];
    const results = extractToolResults(content);
    expect(results).toHaveLength(1);
    expect(results[0].toolUseId).toBe('tu_01');
    expect(results[0].content).toBe('export const theme = { dark: false };');
  });

  it('truncates content longer than 500 chars', () => {
    const longContent = 'x'.repeat(600);
    const blocks = [{ type: 'tool_result', tool_use_id: 'tu_99', content: longContent }];
    const results = extractToolResults(blocks);
    expect(results[0].content.length).toBe(503); // 500 + '...'
    expect(results[0].content.endsWith('...')).toBe(true);
  });

  it('returns empty array for string content', () => {
    expect(extractToolResults('plain text')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hasThinkingBlock
// ---------------------------------------------------------------------------

describe('hasThinkingBlock', () => {
  it('returns true when thinking block is present', () => {
    const raw = parseJsonLine(ASSISTANT_THINKING_LINE)!;
    const content = raw.message!.content as import('../types.js').ContentBlock[];
    expect(hasThinkingBlock(content)).toBe(true);
  });

  it('returns false for string content', () => {
    expect(hasThinkingBlock('just text')).toBe(false);
  });

  it('returns false when no thinking blocks', () => {
    const blocks = [{ type: 'text', text: 'hello' }];
    expect(hasThinkingBlock(blocks)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSessionFile — full integration via temp files
// ---------------------------------------------------------------------------

describe('parseSessionFile', () => {
  it('parses valid JSONL file with user and assistant messages', async () => {
    const jsonl = [USER_LINE, ASSISTANT_TEXT_LINE].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.lineCount).toBe(2);
    expect(result.warnings).toHaveLength(0);
  });

  it('handles progress lines without crashing', async () => {
    const jsonl = [USER_LINE, PROGRESS_LINE, ASSISTANT_TEXT_LINE].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const result = await parseSessionFile(filePath);
    // progress line is normalized (role=unknown), not dropped
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1].rawType).toBe('progress');
    expect(result.warnings).toHaveLength(0);
  });

  it('handles file-history-snapshot lines without crashing', async () => {
    const jsonl = [USER_LINE, FILE_HISTORY_SNAPSHOT_LINE, ASSISTANT_TEXT_LINE].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1].rawType).toBe('file-history-snapshot');
    expect(result.warnings).toHaveLength(0);
  });

  it('handles queue-operation lines without crashing', async () => {
    const jsonl = [USER_LINE, QUEUE_OPERATION_LINE, ASSISTANT_TEXT_LINE].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1].rawType).toBe('queue-operation');
    expect(result.warnings).toHaveLength(0);
  });

  it('extracts text content from user messages', async () => {
    const filePath = writeTmpJsonl(USER_LINE);
    const result = await parseSessionFile(filePath);

    expect(result.messages[0].textContent).toBe('How do I add dark mode?');
  });

  it('extracts text from assistant messages (content blocks with type text)', async () => {
    const filePath = writeTmpJsonl(ASSISTANT_TEXT_LINE);
    const result = await parseSessionFile(filePath);

    expect(result.messages[0].textContent).toBe(
      'You can add dark mode by using CSS variables.',
    );
  });

  it('handles tool_use blocks in assistant messages (extracts tool name)', async () => {
    const filePath = writeTmpJsonl(ASSISTANT_TOOL_USE_LINE);
    const result = await parseSessionFile(filePath);

    expect(result.messages[0].toolUses).toHaveLength(1);
    expect(result.messages[0].toolUses[0].name).toBe('Read');
    expect(result.messages[0].textContent).toBe('Let me read the file first.');
  });

  it('skips malformed/corrupt lines gracefully', async () => {
    const jsonl = [
      USER_LINE,
      '{this is not valid json!!!',
      'also not json',
      ASSISTANT_TEXT_LINE,
    ].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0].lineNumber).toBe(2);
    expect(result.warnings[0].error).toBe('Invalid JSON');
    expect(result.warnings[1].lineNumber).toBe(3);
  });

  it('empty file returns empty session', async () => {
    const filePath = writeTmpJsonl('');
    const result = await parseSessionFile(filePath);

    expect(result.messages).toHaveLength(0);
    expect(result.summary).toBeNull();
    expect(result.warnings).toHaveLength(0);
    expect(result.lineCount).toBe(0);
  });

  it('counts messages correctly (user vs assistant)', async () => {
    const jsonl = [
      USER_LINE,
      ASSISTANT_TEXT_LINE,
      USER_LINE,
      ASSISTANT_TOOL_USE_LINE,
      ASSISTANT_THINKING_LINE,
    ].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const result = await parseSessionFile(filePath);
    const userMessages = result.messages.filter((m) => m.role === 'user');
    const assistantMessages = result.messages.filter((m) => m.role === 'assistant');

    expect(userMessages).toHaveLength(2);
    expect(assistantMessages).toHaveLength(3);
    expect(result.lineCount).toBe(5);
  });

  it('captures the last summary line', async () => {
    const jsonl = [USER_LINE, ASSISTANT_TEXT_LINE, SUMMARY_LINE].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const result = await parseSessionFile(filePath);
    expect(result.summary).toBe('Added dark mode support using CSS variables.');
    // summary lines are NOT included in messages
    expect(result.messages).toHaveLength(2);
  });

  it('detects thinking blocks in assistant messages', async () => {
    const filePath = writeTmpJsonl(ASSISTANT_THINKING_LINE);
    const result = await parseSessionFile(filePath);

    expect(result.messages[0].hasThinking).toBe(true);
    expect(result.messages[0].textContent).toBe('Let me check your theme config.');
  });

  it('blank lines produce no warnings', async () => {
    const jsonl = [USER_LINE, '', '  ', ASSISTANT_TEXT_LINE].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const result = await parseSessionFile(filePath);
    expect(result.messages).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
  });

  it('parses a realistic full session', async () => {
    const jsonl = [
      SYSTEM_LINE,
      USER_LINE,
      PROGRESS_LINE,
      ASSISTANT_THINKING_LINE,
      ASSISTANT_TOOL_USE_LINE,
      ASSISTANT_TOOL_RESULT_LINE,
      FILE_HISTORY_SNAPSHOT_LINE,
      QUEUE_OPERATION_LINE,
      ASSISTANT_TEXT_LINE,
      SUMMARY_LINE,
    ].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const result = await parseSessionFile(filePath);
    expect(result.lineCount).toBe(10);
    expect(result.summary).toBe('Added dark mode support using CSS variables.');
    // summary excluded from messages; all other 9 lines become messages
    expect(result.messages).toHaveLength(9);
    expect(result.warnings).toHaveLength(0);

    const roles = result.messages.map((m) => m.role);
    expect(roles.filter((r) => r === 'user')).toHaveLength(1);
    expect(roles.filter((r) => r === 'assistant')).toHaveLength(4);
    expect(roles.filter((r) => r === 'system')).toHaveLength(1);
    expect(roles.filter((r) => r === 'unknown')).toHaveLength(3); // progress, file-history-snapshot, queue-operation
  });
});

// ---------------------------------------------------------------------------
// extractToolResults — non-string content (truncateContent branch)
// ---------------------------------------------------------------------------

describe('extractToolResults — non-string content', () => {
  it('serialises object content via JSON.stringify', () => {
    const blocks = [
      { type: 'tool_result', tool_use_id: 'tu_10', content: { ok: true, lines: 42 } },
    ];
    const results = extractToolResults(blocks);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('{"ok":true,"lines":42}');
  });

  it('truncates serialised object content longer than 500 chars', () => {
    const big = { data: 'y'.repeat(600) };
    const blocks = [{ type: 'tool_result', tool_use_id: 'tu_11', content: big }];
    const results = extractToolResults(blocks);
    expect(results[0].content.length).toBe(503);
    expect(results[0].content.endsWith('...')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSessionInfo — integration
// ---------------------------------------------------------------------------

describe('buildSessionInfo', () => {
  function makeSessionFile(filePath: string): SessionFileInfo {
    const stat = statSync(filePath);
    return {
      sessionId: 'test-session-001',
      filePath,
      fileSize: stat.size,
      modifiedAt: stat.mtime,
      createdAt: null,
    };
  }

  it('aggregates counts and metadata from a session file', async () => {
    const jsonl = [
      USER_LINE,
      ASSISTANT_TOOL_USE_LINE,
      ASSISTANT_TEXT_LINE,
    ].join('\n');
    const filePath = writeTmpJsonl(jsonl);

    const info = await buildSessionInfo(
      makeSessionFile(filePath),
      '/home/user/project',
      '-home-user-project',
    );

    expect(info.sessionId).toBe('test-session-001');
    expect(info.projectPath).toBe('/home/user/project');
    expect(info.projectPathEncoded).toBe('-home-user-project');
    expect(info.userMessageCount).toBe(1);
    expect(info.assistantMessageCount).toBe(2);
    expect(info.toolUseCount).toBe(1); // one Read tool_use in ASSISTANT_TOOL_USE_LINE
    expect(info.messageCount).toBe(3); // lineCount
    expect(info.messages).toHaveLength(3);
  });

  it('computes duration from first to last timestamp', async () => {
    // USER_LINE: 14:00:00, ASSISTANT_TEXT_LINE: 14:00:05 → 0 min (rounds)
    // Use lines with a bigger gap to verify real duration
    const earlyLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'start' },
      timestamp: '2025-04-10T10:00:00.000Z',
    });
    const lateLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      timestamp: '2025-04-10T10:47:00.000Z',
    });

    const filePath = writeTmpJsonl([earlyLine, lateLine].join('\n'));
    const info = await buildSessionInfo(
      makeSessionFile(filePath),
      '/proj',
      '-proj',
    );

    expect(info.firstTimestamp).toBe('2025-04-10T10:00:00.000Z');
    expect(info.lastTimestamp).toBe('2025-04-10T10:47:00.000Z');
    expect(info.durationMinutes).toBe(47);
  });

  it('sets duration to null when no timestamps exist', async () => {
    const noTs = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hi' },
    });
    const filePath = writeTmpJsonl(noTs);
    const info = await buildSessionInfo(
      makeSessionFile(filePath),
      '/proj',
      '-proj',
    );

    expect(info.firstTimestamp).toBeNull();
    expect(info.lastTimestamp).toBeNull();
    expect(info.durationMinutes).toBeNull();
  });

  it('captures summary from the file', async () => {
    const jsonl = [USER_LINE, SUMMARY_LINE].join('\n');
    const filePath = writeTmpJsonl(jsonl);
    const info = await buildSessionInfo(
      makeSessionFile(filePath),
      '/proj',
      '-proj',
    );

    expect(info.summary).toBe('Added dark mode support using CSS variables.');
  });

  it('counts tool uses across multiple messages', async () => {
    const multiTool = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      timestamp: '2025-04-10T14:00:20.000Z',
    });

    const jsonl = [USER_LINE, ASSISTANT_TOOL_USE_LINE, multiTool].join('\n');
    const filePath = writeTmpJsonl(jsonl);
    const info = await buildSessionInfo(
      makeSessionFile(filePath),
      '/proj',
      '-proj',
    );

    // ASSISTANT_TOOL_USE_LINE has 1 tool_use, multiTool has 2 → total 3
    expect(info.toolUseCount).toBe(3);
  });
});
