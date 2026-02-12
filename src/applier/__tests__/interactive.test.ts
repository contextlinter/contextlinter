import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Suggestion } from '../../suggester/types.js';
import type { ApplyOptions } from '../types.js';

// Mock file-writer and history so we never touch the filesystem
vi.mock('../file-writer.js', () => ({
  applySuggestion: vi.fn(async (suggestion: Suggestion) => ({
    success: true,
    action: 'modified' as const,
    filePath: `/fake/project/${suggestion.targetFile}`,
    backupPath: null,
  })),
  getContentPreview: vi.fn(() => '- mocked content'),
  resetBackupTracking: vi.fn(),
}));

vi.mock('../history.js', () => ({
  appendHistoryEntry: vi.fn(async () => {}),
  buildHistoryEntry: vi.fn(() => ({
    timestamp: new Date().toISOString(),
    action: 'add',
    file: 'CLAUDE.md',
    section: null,
    content: '',
    previousContent: null,
    reason: '',
    sourceInsightIds: [],
    sourceSessionIds: [],
    confidence: 0.9,
  })),
}));

import { runInteractiveReview } from '../interactive.js';
import { applySuggestion } from '../file-writer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: 'test-001',
    type: 'add',
    priority: 'medium',
    confidence: 0.9,
    title: 'Test suggestion',
    rationale: 'Testing purposes',
    targetFile: 'CLAUDE.md',
    targetSection: null,
    diff: {
      type: 'add',
      afterLine: null,
      inSection: null,
      removedLines: null,
      addedLines: [{ lineNumber: null, content: '- test rule' }],
      parts: null,
    },
    splitTarget: null,
    sourceInsightIds: ['insight-1'],
    sourceSessionIds: ['session-1'],
    status: 'pending',
    ...overrides,
  };
}

function defaultOptions(overrides: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    verbose: false,
    yes: false,
    dryRun: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// --yes mode
// ---------------------------------------------------------------------------

describe('--yes mode', () => {
  it('auto-accepts all suggestions', async () => {
    const suggestions = [
      makeSuggestion({ id: 's1', confidence: 0.5 }),
      makeSuggestion({ id: 's2', confidence: 0.9 }),
      makeSuggestion({ id: 's3', confidence: 0.3 }),
    ];

    const session = await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ yes: true }),
    );

    expect(session.results).toHaveLength(3);
    for (const result of session.results) {
      expect(result.action).toBe('accept');
    }
  });

  it('calls applySuggestion for every suggestion', async () => {
    const suggestions = [
      makeSuggestion({ id: 's1' }),
      makeSuggestion({ id: 's2' }),
    ];

    await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ yes: true }),
    );

    expect(applySuggestion).toHaveBeenCalledTimes(2);
  });

  it('returns correct session metadata', async () => {
    const suggestions = [makeSuggestion({ id: 's1' })];

    const session = await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ yes: true }),
    );

    expect(session.projectPath).toBe('/fake/project');
    expect(session.results[0].suggestionId).toBe('s1');
    expect(session.results[0].appliedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// --dry-run mode
// ---------------------------------------------------------------------------

describe('--dry-run mode', () => {
  it('never calls applySuggestion', async () => {
    const suggestions = [
      makeSuggestion({ id: 's1' }),
      makeSuggestion({ id: 's2' }),
    ];

    await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ dryRun: true }),
    );

    expect(applySuggestion).not.toHaveBeenCalled();
  });

  it('returns empty results (no actions recorded)', async () => {
    const suggestions = [
      makeSuggestion({ id: 's1' }),
      makeSuggestion({ id: 's2' }),
    ];

    const session = await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ dryRun: true }),
    );

    expect(session.results).toHaveLength(0);
  });

  it('reports no files modified or created', async () => {
    const suggestions = [makeSuggestion({ id: 's1' })];

    const session = await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ dryRun: true }),
    );

    expect(session.filesModified).toHaveLength(0);
    expect(session.filesCreated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// --min-confidence
// ---------------------------------------------------------------------------

describe('--min-confidence', () => {
  it('auto-accepts suggestions at or above threshold', async () => {
    const suggestions = [
      makeSuggestion({ id: 'high', confidence: 0.95 }),
      makeSuggestion({ id: 'exact', confidence: 0.8 }),
    ];

    const session = await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ minConfidence: 0.8 }),
    );

    expect(session.results).toHaveLength(2);
    expect(session.results[0].action).toBe('accept');
    expect(session.results[0].suggestionId).toBe('high');
    expect(session.results[1].action).toBe('accept');
    expect(session.results[1].suggestionId).toBe('exact');
  });

  it('skips suggestions below threshold', async () => {
    const suggestions = [
      makeSuggestion({ id: 'below', confidence: 0.5 }),
      makeSuggestion({ id: 'way-below', confidence: 0.1 }),
    ];

    const session = await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ minConfidence: 0.8 }),
    );

    expect(session.results).toHaveLength(2);
    for (const result of session.results) {
      expect(result.action).toBe('skip');
      expect(result.appliedAt).toBeNull();
    }
  });

  it('handles mixed above/below threshold correctly', async () => {
    const suggestions = [
      makeSuggestion({ id: 'above', confidence: 0.85 }),
      makeSuggestion({ id: 'below', confidence: 0.7 }),
      makeSuggestion({ id: 'exact', confidence: 0.8 }),
    ];

    const session = await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ minConfidence: 0.8 }),
    );

    expect(session.results).toHaveLength(3);
    expect(session.results[0].action).toBe('accept');
    expect(session.results[1].action).toBe('skip');
    expect(session.results[2].action).toBe('accept');

    // applySuggestion called only for the two accepted ones
    expect(applySuggestion).toHaveBeenCalledTimes(2);
  });

  it('does not call applySuggestion for skipped suggestions', async () => {
    const suggestions = [
      makeSuggestion({ id: 'low', confidence: 0.3 }),
    ];

    await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ minConfidence: 0.8 }),
    );

    expect(applySuggestion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

describe('priority ordering', () => {
  it('processes suggestions in the order provided (high → medium → low)', async () => {
    const suggestions = [
      makeSuggestion({ id: 'high-1', priority: 'high', confidence: 0.9 }),
      makeSuggestion({ id: 'high-2', priority: 'high', confidence: 0.85 }),
      makeSuggestion({ id: 'med-1', priority: 'medium', confidence: 0.8 }),
      makeSuggestion({ id: 'low-1', priority: 'low', confidence: 0.7 }),
    ];

    const session = await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ yes: true }),
    );

    expect(session.results.map((r) => r.suggestionId)).toEqual([
      'high-1',
      'high-2',
      'med-1',
      'low-1',
    ]);
  });

  it('maintains input order without resorting', async () => {
    // Intentionally pass in non-priority order
    const suggestions = [
      makeSuggestion({ id: 'low-1', priority: 'low', confidence: 0.9 }),
      makeSuggestion({ id: 'high-1', priority: 'high', confidence: 0.9 }),
    ];

    const session = await runInteractiveReview(
      suggestions,
      '/fake/project',
      '/fake/store',
      defaultOptions({ yes: true }),
    );

    // Results should match input order, not be re-sorted
    expect(session.results[0].suggestionId).toBe('low-1');
    expect(session.results[1].suggestionId).toBe('high-1');
  });
});

// ---------------------------------------------------------------------------
// Empty suggestions
// ---------------------------------------------------------------------------

describe('empty suggestions', () => {
  it('returns an empty session when no suggestions are provided', async () => {
    const session = await runInteractiveReview(
      [],
      '/fake/project',
      '/fake/store',
      defaultOptions({ yes: true }),
    );

    expect(session.results).toHaveLength(0);
    expect(session.filesModified).toHaveLength(0);
    expect(session.filesCreated).toHaveLength(0);
    expect(applySuggestion).not.toHaveBeenCalled();
  });
});
