import { describe, it, expect, beforeEach } from 'vitest';
import type { NormalizedMessage, SessionInfo } from '../../session-reader/types.js';
import type { PreparedMessage, ToolUsageSummary } from '../types.js';
import {
  prepareSession,
  aggregateToolUsage,
  formatToolUsageSummary,
  formatConversation,
  isSessionAnalyzable,
} from '../preparer.js';

// ---------------------------------------------------------------------------
// Helpers — build realistic fixtures
// ---------------------------------------------------------------------------

let msgIndex = 0;

beforeEach(() => {
  msgIndex = 0;
});

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    role: 'user',
    timestamp: `2025-01-15T10:${String(msgIndex++).padStart(2, '0')}:00Z`,
    textContent: 'Hello',
    toolUses: [],
    toolResults: [],
    hasThinking: false,
    rawType: 'message',
    ...overrides,
  };
}

function userMsg(text = 'Fix the bug', tools: string[] = []): NormalizedMessage {
  return makeMsg({
    role: 'user',
    textContent: text,
    toolUses: tools.map((name, i) => ({ id: `tu-${msgIndex}-${i}`, name, input: {} })),
  });
}

function assistantMsg(text = 'I will fix it', tools: string[] = []): NormalizedMessage {
  return makeMsg({
    role: 'assistant',
    textContent: text,
    toolUses: tools.map((name, i) => ({ id: `tu-${msgIndex}-${i}`, name, input: {} })),
  });
}

function progressMsg(): NormalizedMessage {
  return makeMsg({ role: 'assistant', rawType: 'progress', textContent: 'Working...' });
}

function fileHistoryMsg(): NormalizedMessage {
  return makeMsg({ role: 'system', rawType: 'file-history-snapshot', textContent: '{}' });
}

function queueOpMsg(): NormalizedMessage {
  return makeMsg({ role: 'system', rawType: 'queue-operation', textContent: '' });
}

/** Build N user→assistant exchange pairs. */
function makeExchanges(n: number): NormalizedMessage[] {
  const msgs: NormalizedMessage[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push(userMsg(`User message ${i}`));
    msgs.push(assistantMsg(`Assistant response ${i}`, ['Read']));
  }
  return msgs;
}

function makeSession(messages: NormalizedMessage[], overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'test-session-1',
    projectPath: '/home/user/project',
    projectPathEncoded: '-home-user-project',
    filePath: '/home/user/.claude/projects/-home-user-project/test-session-1.jsonl',
    fileSize: 50000,
    messageCount: messages.length,
    userMessageCount: messages.filter((m) => m.role === 'user').length,
    assistantMessageCount: messages.filter((m) => m.role === 'assistant').length,
    toolUseCount: messages.reduce((sum, m) => sum + m.toolUses.length, 0),
    firstTimestamp: messages[0]?.timestamp ?? null,
    lastTimestamp: messages.at(-1)?.timestamp ?? null,
    durationMinutes: 30,
    summary: null,
    messages,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('filtering', () => {
  it('removes progress messages from conversation output', () => {
    const messages = [userMsg(), progressMsg(), assistantMsg()];
    const result = prepareSession(makeSession(messages));

    expect(result.messages.every((m) => !m.text.includes('Working...'))).toBe(true);
    expect(result.totalMessagesBeforeFilter).toBe(3);
  });

  it('removes file-history-snapshot messages', () => {
    const messages = [userMsg(), fileHistoryMsg(), assistantMsg()];
    const result = prepareSession(makeSession(messages));

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });

  it('removes queue-operation messages', () => {
    const messages = [userMsg(), queueOpMsg(), assistantMsg()];
    const result = prepareSession(makeSession(messages));

    // queue-operation has role 'system' which is already filtered, but rawType is also checked
    expect(result.messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
  });

  it('removes pr-link messages', () => {
    const messages = [
      userMsg(),
      makeMsg({ role: 'assistant', rawType: 'pr-link', textContent: 'PR #42' }),
      assistantMsg(),
    ];
    const result = prepareSession(makeSession(messages));

    expect(result.messages).toHaveLength(2);
  });

  it('filters out empty messages (no text and no tools)', () => {
    const messages = [
      userMsg('Ask something'),
      assistantMsg(''),  // empty text, no tools → should be removed
      assistantMsg('Real answer'),
    ];
    const result = prepareSession(makeSession(messages));

    expect(result.messages.every((m) => m.text.length > 0 || m.toolNames.length > 0)).toBe(true);
  });

  it('keeps messages with tools even if text is empty', () => {
    const messages = [
      userMsg('Read the file'),
      makeMsg({ role: 'assistant', textContent: '', toolUses: [{ id: 'tu-1', name: 'Read', input: { file_path: '/foo' } }] }),
    ];
    const result = prepareSession(makeSession(messages));

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].toolNames).toEqual(['Read']);
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('truncation', () => {
  it('truncates messages longer than 500 chars with "..." suffix', () => {
    const longText = 'x'.repeat(600);
    const messages = [userMsg(longText), assistantMsg('ok')];
    const result = prepareSession(makeSession(messages));

    expect(result.messages[0].text).toHaveLength(503); // 500 + '...'
    expect(result.messages[0].text.endsWith('...')).toBe(true);
  });

  it('does not truncate messages at or under 500 chars', () => {
    const exactText = 'a'.repeat(500);
    const messages = [userMsg(exactText), assistantMsg('ok')];
    const result = prepareSession(makeSession(messages));

    expect(result.messages[0].text).toBe(exactText);
    expect(result.messages[0].text).not.toContain('...');
  });

  it('does not truncate short messages', () => {
    const messages = [userMsg('hello'), assistantMsg('world')];
    const result = prepareSession(makeSession(messages));

    expect(result.messages[0].text).toBe('hello');
    expect(result.messages[1].text).toBe('world');
  });
});

// ---------------------------------------------------------------------------
// Sampling — exchange-based
// ---------------------------------------------------------------------------

describe('sampling', () => {
  it('does NOT sample when messages are below limit (150)', () => {
    // 60 exchanges = 120 messages, under 150
    const messages = makeExchanges(60);
    const result = prepareSession(makeSession(messages));

    expect(result.wasSampled).toBe(false);
    expect(result.messages).toHaveLength(120);
  });

  it('samples when messages exceed limit (150)', () => {
    // 100 exchanges = 200 messages, over 150
    const messages = makeExchanges(100);
    const result = prepareSession(makeSession(messages));

    expect(result.wasSampled).toBe(true);
    expect(result.messages.length).toBeLessThan(200);
  });

  it('keeps user→assistant pairs together (no orphaned assistants)', () => {
    const messages = makeExchanges(100);
    const result = prepareSession(makeSession(messages));

    // Walk through messages: an assistant message should never appear
    // right after a skip marker or at position 0 without a preceding user message
    for (let i = 0; i < result.messages.length; i++) {
      const msg = result.messages[i];
      if (msg.role === 'assistant' && msg.originalIndex !== -1) {
        // Not a skip marker — check there's a user msg before it (or another assistant in same exchange)
        if (i === 0) {
          // First message should not be an orphaned assistant
          expect(msg.role).not.toBe('assistant');
        } else {
          const prev = result.messages[i - 1];
          // Previous should be user or another assistant (same exchange), not a skip marker that just ended
          const isPartOfExchange = prev.role === 'user' || prev.role === 'assistant';
          expect(isPartOfExchange).toBe(true);
        }
      }
    }
  });

  it('keeps user→assistant pairs together (no orphaned users at end)', () => {
    const messages = makeExchanges(100);
    const result = prepareSession(makeSession(messages));

    // Find all real (non-skip-marker) user messages
    const realMessages = result.messages.filter((m) => m.originalIndex !== -1);
    for (let i = 0; i < realMessages.length; i++) {
      if (realMessages[i].role === 'user') {
        // Must be followed by an assistant, unless it's the very last message
        if (i < realMessages.length - 1) {
          // The next real message should eventually be an assistant in the same exchange
          // or another user starting a new exchange (which is fine — next exchange)
        }
      }
    }

    // More direct check: within each contiguous group between skip markers,
    // user/assistant pairing should be intact
    const groups: PreparedMessage[][] = [];
    let currentGroup: PreparedMessage[] = [];
    for (const msg of result.messages) {
      if (msg.originalIndex === -1) {
        if (currentGroup.length > 0) groups.push(currentGroup);
        currentGroup = [];
      } else {
        currentGroup.push(msg);
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);

    for (const group of groups) {
      if (group.length === 0) continue;
      // Last message in each group should be assistant (completed exchange)
      // unless group has only one message (edge case of trailing user)
      const lastMsg = group[group.length - 1];
      if (group.length > 1) {
        expect(lastMsg.role).toBe('assistant');
      }
    }
  });

  it('sampling takes first N, last N, and random middle exchanges', () => {
    // 100 exchanges = 200 messages (above 150 limit); with head=10, tail=10, middle=10
    // total exchanges used = 30, so we expect ~60 messages + 2 skip markers
    const messages = makeExchanges(100);
    const result = prepareSession(makeSession(messages));

    expect(result.wasSampled).toBe(true);

    // Verify head: first messages should match first exchanges
    expect(result.messages[0].text).toBe('User message 0');

    // Verify tail: last real messages should be from the last exchanges
    const realMessages = result.messages.filter((m) => m.originalIndex !== -1);
    const lastRealMsg = realMessages[realMessages.length - 1];
    expect(lastRealMsg.text).toBe('Assistant response 99');

    // Verify skip markers exist
    const skipMarkers = result.messages.filter((m) => m.originalIndex === -1);
    expect(skipMarkers.length).toBe(2);
    expect(skipMarkers[0].text).toContain('skipped');
  });

  it('returns all messages when exchanges fit within head+tail+middle budget', () => {
    // 25 exchanges = 50 messages; budget is 30 exchanges, so no actual sampling needed
    const messages = makeExchanges(25);
    // Force through sampleMessages by having >150 individual messages
    // Actually 50 messages < 150, so it won't sample at all. Let's verify that.
    const result = prepareSession(makeSession(messages));

    expect(result.wasSampled).toBe(false);
    expect(result.messages).toHaveLength(50);
  });

  it('sampled output is approximately 150 messages or fewer', () => {
    // 200 exchanges = 400 messages
    const messages = makeExchanges(200);
    const result = prepareSession(makeSession(messages));

    expect(result.wasSampled).toBe(true);
    // head=10 + tail=10 + middle=10 = 30 exchanges ≈ 60 msgs + 2 skip markers
    // Should be well under 150
    expect(result.messages.length).toBeLessThanOrEqual(150);
  });

  it('preserves originalIndex ordering within sampled output', () => {
    const messages = makeExchanges(100);
    const result = prepareSession(makeSession(messages));

    const realMessages = result.messages.filter((m) => m.originalIndex !== -1);
    for (let i = 1; i < realMessages.length; i++) {
      expect(realMessages[i].originalIndex).toBeGreaterThan(realMessages[i - 1].originalIndex);
    }
  });
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe('token estimation', () => {
  it('includes prompt overhead (~750 tokens = ~3000 chars)', () => {
    // Even a single short message should produce at least 750 tokens from overhead
    const messages = [userMsg('hi'), assistantMsg('hello')];
    const result = prepareSession(makeSession(messages));

    // 3000 chars overhead / 4 chars per token = 750 tokens minimum
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(750);
  });

  it('grows proportionally with message count', () => {
    const small = prepareSession(makeSession(makeExchanges(5)));
    const large = prepareSession(makeSession(makeExchanges(50)));

    expect(large.estimatedTokens).toBeGreaterThan(small.estimatedTokens);
    // large has 10x the messages; fixed overhead dampens the ratio
    const ratio = large.estimatedTokens / small.estimatedTokens;
    expect(ratio).toBeGreaterThan(1.5);
  });

  it('accounts for tool names in token estimation', () => {
    const noTools = prepareSession(makeSession([
      userMsg('do it'),
      assistantMsg('done'),
    ]));
    const withTools = prepareSession(makeSession([
      userMsg('do it'),
      makeMsg({
        role: 'assistant',
        textContent: 'done',
        toolUses: [
          { id: 'tu-1', name: 'Read', input: {} },
          { id: 'tu-2', name: 'Write', input: {} },
          { id: 'tu-3', name: 'Bash', input: {} },
        ],
      }),
    ]));

    expect(withTools.estimatedTokens).toBeGreaterThan(noTools.estimatedTokens);
  });
});

// ---------------------------------------------------------------------------
// Tool usage aggregation
// ---------------------------------------------------------------------------

describe('aggregateToolUsage', () => {
  it('counts tool calls correctly', () => {
    const messages: NormalizedMessage[] = [
      makeMsg({
        role: 'assistant',
        toolUses: [
          { id: 'tu-1', name: 'Read', input: { file_path: '/src/app.ts' } },
          { id: 'tu-2', name: 'Read', input: { file_path: '/src/utils.ts' } },
        ],
      }),
      makeMsg({
        role: 'assistant',
        toolUses: [
          { id: 'tu-3', name: 'Write', input: { file_path: '/src/app.ts' } },
        ],
      }),
    ];

    const summary = aggregateToolUsage(messages);

    expect(summary.totalToolCalls).toBe(3);
    expect(summary.byTool['Read'].count).toBe(2);
    expect(summary.byTool['Write'].count).toBe(1);
  });

  it('tracks repeated file access above threshold', () => {
    const messages: NormalizedMessage[] = [];
    // Access same file 6 times (above threshold of 5)
    for (let i = 0; i < 6; i++) {
      messages.push(makeMsg({
        role: 'assistant',
        toolUses: [{ id: `tu-${i}`, name: 'Read', input: { file_path: '/src/hot-file.ts' } }],
      }));
    }
    // Access another file only twice (below threshold)
    for (let i = 0; i < 2; i++) {
      messages.push(makeMsg({
        role: 'assistant',
        toolUses: [{ id: `tu-cold-${i}`, name: 'Read', input: { file_path: '/src/cold-file.ts' } }],
      }));
    }

    const summary = aggregateToolUsage(messages);

    expect(summary.repeatedFileAccess).toHaveLength(1);
    expect(summary.repeatedFileAccess[0].filePath).toBe('/src/hot-file.ts');
    expect(summary.repeatedFileAccess[0].readCount).toBe(6);
  });

  it('tracks bash failure rate from tool results', () => {
    const messages: NormalizedMessage[] = [
      makeMsg({
        role: 'assistant',
        toolUses: [{ id: 'bash-1', name: 'Bash', input: { command: 'npm test' } }],
        toolResults: [{ toolUseId: 'bash-1', content: 'exit code 1' }],
      }),
      makeMsg({
        role: 'assistant',
        toolUses: [{ id: 'bash-2', name: 'Bash', input: { command: 'npm build' } }],
        toolResults: [{ toolUseId: 'bash-2', content: 'Build successful' }],
      }),
    ];

    const summary = aggregateToolUsage(messages);

    expect(summary.bashFailureRate).toBe(0.5); // 1 failure out of 2
  });

  it('returns zero bash failure rate when no bash commands', () => {
    const messages: NormalizedMessage[] = [
      makeMsg({
        role: 'assistant',
        toolUses: [{ id: 'tu-1', name: 'Read', input: { file_path: '/foo' } }],
      }),
    ];

    const summary = aggregateToolUsage(messages);
    expect(summary.bashFailureRate).toBe(0);
  });

  it('aggregates progress events into tool usage summary', () => {
    // Progress messages still have toolUses that should be counted
    const messages: NormalizedMessage[] = [
      makeMsg({
        role: 'assistant',
        rawType: 'progress',
        toolUses: [{ id: 'tu-1', name: 'Read', input: { file_path: '/src/main.ts' } }],
      }),
      makeMsg({
        role: 'assistant',
        rawType: 'progress',
        toolUses: [{ id: 'tu-2', name: 'Write', input: { file_path: '/src/main.ts' } }],
      }),
      userMsg('proceed'),
      assistantMsg('done', ['Read']),
    ];

    // aggregateToolUsage runs on ALL messages, including progress
    const summary = aggregateToolUsage(messages);

    expect(summary.totalToolCalls).toBe(3);
    expect(summary.byTool['Read'].count).toBe(2);
    expect(summary.byTool['Write'].count).toBe(1);
  });

  it('sorts repeated file access by total access count descending', () => {
    const messages: NormalizedMessage[] = [];
    // File A: 7 accesses
    for (let i = 0; i < 7; i++) {
      messages.push(makeMsg({
        role: 'assistant',
        toolUses: [{ id: `a-${i}`, name: 'Read', input: { file_path: '/a.ts' } }],
      }));
    }
    // File B: 10 accesses
    for (let i = 0; i < 10; i++) {
      messages.push(makeMsg({
        role: 'assistant',
        toolUses: [{ id: `b-${i}`, name: 'Edit', input: { file_path: '/b.ts' } }],
      }));
    }

    const summary = aggregateToolUsage(messages);

    expect(summary.repeatedFileAccess.length).toBe(2);
    // B (10 total) should come before A (7 total)
    expect(summary.repeatedFileAccess[0].filePath).toBe('/b.ts');
    expect(summary.repeatedFileAccess[1].filePath).toBe('/a.ts');
  });

  it('distinguishes reads from writes in file access tracking', () => {
    const messages: NormalizedMessage[] = [];
    for (let i = 0; i < 3; i++) {
      messages.push(makeMsg({
        role: 'assistant',
        toolUses: [{ id: `r-${i}`, name: 'Read', input: { file_path: '/src/file.ts' } }],
      }));
    }
    for (let i = 0; i < 3; i++) {
      messages.push(makeMsg({
        role: 'assistant',
        toolUses: [{ id: `w-${i}`, name: 'Write', input: { file_path: '/src/file.ts' } }],
      }));
    }

    const summary = aggregateToolUsage(messages);

    // 6 total accesses, above threshold of 5
    expect(summary.repeatedFileAccess).toHaveLength(1);
    expect(summary.repeatedFileAccess[0].readCount).toBe(3);
    expect(summary.repeatedFileAccess[0].writeCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// prepareSession — integration
// ---------------------------------------------------------------------------

describe('prepareSession integration', () => {
  it('returns correct metadata fields', () => {
    const messages = [
      userMsg('Help me'),
      progressMsg(),
      fileHistoryMsg(),
      assistantMsg('Sure', ['Read', 'Write']),
      userMsg('Thanks'),
      assistantMsg('No problem'),
    ];
    const result = prepareSession(makeSession(messages));

    expect(result.sessionId).toBe('test-session-1');
    expect(result.projectPath).toBe('/home/user/project');
    expect(result.totalMessagesBeforeFilter).toBe(6);
    // After filtering: progress removed, file-history removed, leaves 4 conversation msgs
    expect(result.totalMessagesAfterFilter).toBe(4);
    expect(result.wasSampled).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('extracts tool names from assistant messages', () => {
    const messages = [
      userMsg('Read the file'),
      makeMsg({
        role: 'assistant',
        textContent: 'Here is the content',
        toolUses: [
          { id: 'tu-1', name: 'Read', input: { file_path: '/foo' } },
          { id: 'tu-2', name: 'Grep', input: { pattern: 'TODO' } },
        ],
      }),
    ];
    const result = prepareSession(makeSession(messages));

    expect(result.messages[1].toolNames).toEqual(['Read', 'Grep']);
  });

  it('handles completely empty session', () => {
    const result = prepareSession(makeSession([]));

    expect(result.messages).toHaveLength(0);
    expect(result.wasSampled).toBe(false);
    expect(result.totalMessagesBeforeFilter).toBe(0);
    expect(result.totalMessagesAfterFilter).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatToolUsageSummary
// ---------------------------------------------------------------------------

describe('formatToolUsageSummary', () => {
  it('formats tool counts and failures', () => {
    const summary: ToolUsageSummary = {
      totalToolCalls: 15,
      byTool: {
        Read: { count: 8, failures: 0 },
        Bash: { count: 5, failures: 2 },
        Write: { count: 2, failures: 0 },
      },
      repeatedFileAccess: [],
      bashFailureRate: 0.4,
    };

    const output = formatToolUsageSummary(summary);

    expect(output).toContain('Total tool calls: 15');
    expect(output).toContain('Read: 8');
    expect(output).toContain('Bash: 5 (2 failures)');
    expect(output).toContain('Write: 2');
    expect(output).toContain('Bash failure rate: 40%');
  });

  it('includes frequently accessed files', () => {
    const summary: ToolUsageSummary = {
      totalToolCalls: 10,
      byTool: { Read: { count: 10, failures: 0 } },
      repeatedFileAccess: [
        { filePath: '/src/main.ts', readCount: 5, writeCount: 3 },
      ],
      bashFailureRate: 0,
    };

    const output = formatToolUsageSummary(summary);

    expect(output).toContain('Frequently accessed files:');
    expect(output).toContain('/src/main.ts: 5 reads, 3 writes');
  });

  it('omits bash failure rate when zero', () => {
    const summary: ToolUsageSummary = {
      totalToolCalls: 5,
      byTool: { Read: { count: 5, failures: 0 } },
      repeatedFileAccess: [],
      bashFailureRate: 0,
    };

    const output = formatToolUsageSummary(summary);
    expect(output).not.toContain('Bash failure rate');
  });
});

// ---------------------------------------------------------------------------
// formatConversation
// ---------------------------------------------------------------------------

describe('formatConversation', () => {
  it('formats messages with role labels', () => {
    const messages: PreparedMessage[] = [
      { role: 'user', text: 'Fix the bug', toolNames: [], timestamp: null, originalIndex: 0 },
      { role: 'assistant', text: 'Done', toolNames: ['Edit'], timestamp: null, originalIndex: 1 },
    ];

    const output = formatConversation(messages);

    expect(output).toContain('[USER]\nFix the bug');
    expect(output).toContain('[ASSISTANT] [tools: Edit]\nDone');
  });

  it('omits tool annotation when no tools used', () => {
    const messages: PreparedMessage[] = [
      { role: 'user', text: 'Hello', toolNames: [], timestamp: null, originalIndex: 0 },
    ];

    const output = formatConversation(messages);

    expect(output).toBe('[USER]\nHello');
    expect(output).not.toContain('[tools:');
  });
});

// ---------------------------------------------------------------------------
// isSessionAnalyzable
// ---------------------------------------------------------------------------

describe('isSessionAnalyzable', () => {
  it('returns true when userMessageCount >= default (2)', () => {
    const session = makeSession([userMsg(), assistantMsg(), userMsg(), assistantMsg()]);
    expect(isSessionAnalyzable(session)).toBe(true);
  });

  it('returns false when userMessageCount < default (2)', () => {
    const session = makeSession([userMsg(), assistantMsg()]);
    expect(isSessionAnalyzable(session)).toBe(false);
  });

  it('returns false for empty session', () => {
    const session = makeSession([]);
    expect(isSessionAnalyzable(session)).toBe(false);
  });

  it('respects custom minMessages parameter', () => {
    const session = makeSession([userMsg(), assistantMsg(), userMsg(), assistantMsg()]);
    expect(isSessionAnalyzable(session, 3)).toBe(false);
    expect(isSessionAnalyzable(session, 2)).toBe(true);
    expect(isSessionAnalyzable(session, 1)).toBe(true);
  });

  it('returns true when userMessageCount >= 3 with minMessages=3', () => {
    const session = makeSession([userMsg(), assistantMsg(), userMsg(), assistantMsg(), userMsg(), assistantMsg()]);
    expect(isSessionAnalyzable(session, 3)).toBe(true);
  });
});
