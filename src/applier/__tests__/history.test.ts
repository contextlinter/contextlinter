import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RulesHistoryEntry } from '../types.js';
import { appendHistoryEntry } from '../history.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function makeEntry(overrides: Partial<RulesHistoryEntry> = {}): RulesHistoryEntry {
  return {
    timestamp: new Date().toISOString(),
    action: 'add',
    file: 'CLAUDE.md',
    section: null,
    content: '- Test rule',
    previousContent: null,
    reason: 'Testing',
    sourceInsightIds: ['insight-1'],
    sourceSessionIds: ['session-1'],
    confidence: 0.9,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'history-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// appendHistoryEntry
// ---------------------------------------------------------------------------

describe('appendHistoryEntry', () => {
  it('adds a line to end of file', async () => {
    const historyPath = join(tempDir, 'history.jsonl');
    const entry = makeEntry();

    await appendHistoryEntry(historyPath, entry);

    const content = await readFile(historyPath, 'utf-8');
    expect(content).toContain('"action":"add"');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('creates the history file if it does not exist', async () => {
    const historyPath = join(tempDir, 'nested', 'deep', 'history.jsonl');
    const entry = makeEntry();

    await appendHistoryEntry(historyPath, entry);

    const content = await readFile(historyPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('each line is valid JSON (parseable individually)', async () => {
    const historyPath = join(tempDir, 'history.jsonl');

    await appendHistoryEntry(historyPath, makeEntry({ content: '- Rule A' }));
    await appendHistoryEntry(historyPath, makeEntry({ content: '- Rule B' }));
    await appendHistoryEntry(historyPath, makeEntry({ content: '- Rule C' }));

    const content = await readFile(historyPath, 'utf-8');
    const lines = content.trimEnd().split('\n');

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('action');
      expect(parsed).toHaveProperty('content');
    }
  });

  it('does not overwrite existing entries (append-only)', async () => {
    const historyPath = join(tempDir, 'history.jsonl');

    await appendHistoryEntry(historyPath, makeEntry({ content: '- First' }));
    await appendHistoryEntry(historyPath, makeEntry({ content: '- Second' }));

    const content = await readFile(historyPath, 'utf-8');
    expect(content).toContain('"- First"');
    expect(content).toContain('"- Second"');
  });

  it('multiple appends create multiple lines', async () => {
    const historyPath = join(tempDir, 'history.jsonl');

    for (let i = 0; i < 5; i++) {
      await appendHistoryEntry(historyPath, makeEntry({ content: `- Rule ${i}` }));
    }

    const content = await readFile(historyPath, 'utf-8');
    const lines = content.trimEnd().split('\n');
    expect(lines).toHaveLength(5);

    for (let i = 0; i < 5; i++) {
      const parsed = JSON.parse(lines[i]);
      expect(parsed.content).toBe(`- Rule ${i}`);
    }
  });
});
