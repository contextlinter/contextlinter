import { describe, it, expect, beforeEach } from 'vitest';
import { dedupAndRank } from '../dedup.js';
import type { Suggestion } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  idCounter++;
  return {
    id: `s${idCounter}`,
    type: 'add',
    priority: 'medium',
    confidence: 0.7,
    title: 'Untitled',
    rationale: 'test',
    targetFile: 'CLAUDE.md',
    targetSection: null,
    splitTarget: null,
    diff: {
      type: 'add',
      afterLine: 10,
      inSection: null,
      removedLines: null,
      addedLines: [{ lineNumber: null, content: 'Some rule text' }],
      parts: null,
    },
    sourceInsightIds: [],
    sourceSessionIds: [],
    status: 'pending',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dedupAndRank', () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it('keeps distinct suggestions', () => {
    const a = makeSuggestion({
      title: 'Use Vite for bundling',
      diff: {
        type: 'add', afterLine: 10, inSection: null, removedLines: null, parts: null,
        addedLines: [{ lineNumber: null, content: 'Always use Vite for frontend bundling' }],
      },
    });
    const b = makeSuggestion({
      title: 'Run tests with jest',
      diff: {
        type: 'add', afterLine: 20, inSection: null, removedLines: null, parts: null,
        addedLines: [{ lineNumber: null, content: 'Run jest with coverage flag enabled' }],
      },
    });

    const result = dedupAndRank([a, b]);
    expect(result).toHaveLength(2);
  });

  it('deduplicates by title similarity on same file+section', () => {
    const a = makeSuggestion({
      title: 'Document voice and tone guidelines',
      targetFile: 'CLAUDE.md',
      targetSection: 'Voice',
    });
    const b = makeSuggestion({
      title: 'Add voice and tone guidelines to rules',
      targetFile: 'CLAUDE.md',
      targetSection: 'Voice',
    });

    const result = dedupAndRank([a, b]);
    expect(result).toHaveLength(1);
  });

  it('deduplicates by very similar titles across different files', () => {
    const a = makeSuggestion({
      title: 'Add LinkedIn commenting guidelines',
      targetFile: 'CLAUDE.md',
    });
    const b = makeSuggestion({
      title: 'Add LinkedIn commenting guidelines for posts',
      targetFile: 'social/linkedin/CLAUDE.md',
    });

    const result = dedupAndRank([a, b]);
    expect(result).toHaveLength(1);
  });

  it('deduplicates by content similarity across different files', () => {
    const a = makeSuggestion({
      title: 'Voice and tone section',
      targetFile: 'CLAUDE.md',
      targetSection: 'Ton i glos',
      diff: {
        type: 'add',
        afterLine: 10,
        inSection: 'Ton i glos',
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: 'Build on the original poster metaphors and framing' },
          { lineNumber: null, content: 'Match their tone professional casual technical' },
          { lineNumber: null, content: 'Avoid promotional language about your own tools' },
        ],
        parts: null,
      },
    });
    const b = makeSuggestion({
      title: 'Commenting guidelines',
      targetFile: 'social/linkedin/CLAUDE.md',
      targetSection: 'Commenting guidelines',
      diff: {
        type: 'add',
        afterLine: 5,
        inSection: 'Commenting guidelines',
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: 'Build on the original poster metaphors and framing' },
          { lineNumber: null, content: 'Match their tone professional or casual' },
          { lineNumber: null, content: 'Avoid promotional language about your tools and services' },
        ],
        parts: null,
      },
    });

    const result = dedupAndRank([a, b]);
    expect(result).toHaveLength(1);
  });

  it('does NOT deduplicate when content differs significantly', () => {
    const a = makeSuggestion({
      title: 'Voice and tone section',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: 10,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: 'Write as a practitioner not an observer' },
        ],
        parts: null,
      },
    });
    const b = makeSuggestion({
      title: 'Testing conventions',
      targetFile: 'social/linkedin/CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: 5,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: 'Run jest with coverage flag always' },
        ],
        parts: null,
      },
    });

    const result = dedupAndRank([a, b]);
    expect(result).toHaveLength(2);
  });

  it('handles content with Polish characters in similarity', () => {
    const a = makeSuggestion({
      title: 'Ton profesjonalny',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: 10,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: 'Unikaj języka promocyjnego na LinkedIn' },
        ],
        parts: null,
      },
    });
    const b = makeSuggestion({
      title: 'LinkedIn tone',
      targetFile: 'social/CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: 5,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: 'Unikaj języka promocyjnego na LinkedIn' },
        ],
        parts: null,
      },
    });

    const result = dedupAndRank([a, b]);
    expect(result).toHaveLength(1);
  });

  it('handles multi-part diffs in content extraction', () => {
    const a = makeSuggestion({
      title: 'Consolidate voice rules',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: null,
        parts: [
          {
            type: 'remove',
            afterLine: null,
            inSection: null,
            removedLines: [{ lineNumber: 5, content: 'old rule' }],
            addedLines: null,
            parts: null,
          },
          {
            type: 'add',
            afterLine: 5,
            inSection: null,
            removedLines: null,
            addedLines: [
              { lineNumber: null, content: 'Write professionally without promotional language' },
            ],
            parts: null,
          },
        ],
      },
    });
    const b = makeSuggestion({
      title: 'Professional writing rule',
      targetFile: 'social/CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: 10,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: 'Write professionally without promotional language' },
        ],
        parts: null,
      },
    });

    const result = dedupAndRank([a, b]);
    expect(result).toHaveLength(1);
  });

  it('keeps higher priority suggestion when deduplicating', () => {
    const a = makeSuggestion({
      title: 'Add LinkedIn commenting guidelines',
      priority: 'low',
      targetFile: 'CLAUDE.md',
    });
    const b = makeSuggestion({
      title: 'Add LinkedIn commenting guidelines for engagement',
      priority: 'high',
      targetFile: 'CLAUDE.md',
      targetSection: 'Voice',
    });

    const result = dedupAndRank([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0].priority).toBe('high');
  });

  it('ranks by priority then confidence', () => {
    const low = makeSuggestion({
      priority: 'low', confidence: 0.9, title: 'Document deployment pipeline',
      diff: { type: 'add', afterLine: 1, inSection: null, removedLines: null, parts: null,
        addedLines: [{ lineNumber: null, content: 'Deploy to staging environment first' }] },
    });
    const highLow = makeSuggestion({
      priority: 'high', confidence: 0.6, title: 'Use Vite for bundling',
      diff: { type: 'add', afterLine: 2, inSection: null, removedLines: null, parts: null,
        addedLines: [{ lineNumber: null, content: 'Always use Vite for frontend bundling' }] },
    });
    const highHigh = makeSuggestion({
      priority: 'high', confidence: 0.9, title: 'Run jest with coverage',
      diff: { type: 'add', afterLine: 3, inSection: null, removedLines: null, parts: null,
        addedLines: [{ lineNumber: null, content: 'Run jest with coverage flag enabled' }] },
    });
    const med = makeSuggestion({
      priority: 'medium', confidence: 0.8, title: 'Write professional LinkedIn comments',
      diff: { type: 'add', afterLine: 4, inSection: null, removedLines: null, parts: null,
        addedLines: [{ lineNumber: null, content: 'Write professional LinkedIn comments in Polish' }] },
    });

    const result = dedupAndRank([low, highLow, highHigh, med]);
    expect(result.map((s) => s.title)).toEqual([
      'Run jest with coverage',
      'Use Vite for bundling',
      'Write professional LinkedIn comments',
      'Document deployment pipeline',
    ]);
  });
});
