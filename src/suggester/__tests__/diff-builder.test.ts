import { describe, it, expect } from 'vitest';
import { buildDiff } from '../diff-builder.js';
import type { LlmSuggestion } from '../types.js';
import type { RulesFile, RulesSnapshot } from '../../rules-reader/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRulesFile(overrides: Partial<RulesFile> = {}): RulesFile {
  return {
    path: '/project/CLAUDE.md',
    scope: 'project',
    relativePath: 'CLAUDE.md',
    content: [
      '# Architecture',
      '',
      '- Use Vite for bundling',
      '- me-web is a CSR app',
      '',
      '# Testing',
      '',
      '- Run tests with jest --coverage',
      '- Use jest.mock() for mocking',
      '',
      '# Deployment',
      '',
      '- Deploy to staging first',
    ].join('\n'),
    rules: [
      {
        id: 'r1', text: 'Use Vite for bundling', section: 'Architecture',
        sectionHierarchy: ['Architecture'], sourceFile: '/project/CLAUDE.md',
        sourceScope: 'project', lineStart: 3, lineEnd: 3,
        format: 'bullet_point', emphasis: 'normal', imports: [],
      },
      {
        id: 'r2', text: 'me-web is a CSR app', section: 'Architecture',
        sectionHierarchy: ['Architecture'], sourceFile: '/project/CLAUDE.md',
        sourceScope: 'project', lineStart: 4, lineEnd: 4,
        format: 'bullet_point', emphasis: 'normal', imports: [],
      },
      {
        id: 'r3', text: 'Run tests with jest --coverage', section: 'Testing',
        sectionHierarchy: ['Testing'], sourceFile: '/project/CLAUDE.md',
        sourceScope: 'project', lineStart: 8, lineEnd: 8,
        format: 'bullet_point', emphasis: 'normal', imports: [],
      },
      {
        id: 'r4', text: 'Use jest.mock() for mocking', section: 'Testing',
        sectionHierarchy: ['Testing'], sourceFile: '/project/CLAUDE.md',
        sourceScope: 'project', lineStart: 9, lineEnd: 9,
        format: 'bullet_point', emphasis: 'normal', imports: [],
      },
      {
        id: 'r5', text: 'Deploy to staging first', section: 'Deployment',
        sectionHierarchy: ['Deployment'], sourceFile: '/project/CLAUDE.md',
        sourceScope: 'project', lineStart: 13, lineEnd: 13,
        format: 'bullet_point', emphasis: 'normal', imports: [],
      },
    ],
    imports: [],
    lastModified: Date.now(),
    sizeBytes: 200,
  };
}

function makeSnapshot(file?: RulesFile): RulesSnapshot {
  const f = file ?? makeRulesFile();
  return {
    projectRoot: '/project',
    snapshotAt: new Date().toISOString(),
    files: [f],
    allRules: f.rules,
    stats: {
      totalFiles: 1,
      totalRules: f.rules.length,
      byScope: { global: 0, project: f.rules.length, project_local: 0, subdirectory: 0 },
      byFormat: { heading_section: 0, bullet_point: f.rules.length, paragraph: 0, command: 0, emphatic: 0 },
      totalLines: f.content.split('\n').length,
      totalSizeBytes: f.sizeBytes,
      hasGlobalRules: false,
      hasLocalRules: false,
      hasModularRules: false,
      importCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Update type: reads real section content from file
// ---------------------------------------------------------------------------

describe('buildUpdateDiff — reads section content from file', () => {
  it('produces replace diff with real old text from the target section', () => {
    const snapshot = makeSnapshot();
    const raw: LlmSuggestion = {
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: 'Testing',
      title: 'Update test runner',
      rationale: 'Switched to vitest',
      priority: 'medium',
      content: {
        add: '## Testing\n\n- Run tests with vitest run\n- Use vi.mock() for mocking',
        remove: null,
      },
      insightIds: ['i1'],
      skipped: false,
      skipReason: null,
    };

    const diff = buildDiff(raw, snapshot, 'CLAUDE.md', 'Testing');

    expect(diff).not.toBeNull();
    expect(diff!.type).toBe('replace');

    // removedLines should be the REAL content from the file's Testing section
    expect(diff!.removedLines).not.toBeNull();
    const removedTexts = diff!.removedLines!.map((l) => l.content);
    expect(removedTexts).toContain('# Testing');
    expect(removedTexts).toContain('- Run tests with jest --coverage');
    expect(removedTexts).toContain('- Use jest.mock() for mocking');

    // All removed lines should have real line numbers
    for (const line of diff!.removedLines!) {
      expect(line.lineNumber).toBeTypeOf('number');
    }

    // addedLines should be the new content from the LLM
    expect(diff!.addedLines).not.toBeNull();
    const addedTexts = diff!.addedLines!.map((l) => l.content);
    expect(addedTexts).toContain('- Run tests with vitest run');
    expect(addedTexts).toContain('- Use vi.mock() for mocking');
  });

  it('works with null remove field (the common LLM case)', () => {
    const snapshot = makeSnapshot();
    const raw: LlmSuggestion = {
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: 'Architecture',
      title: 'Update architecture rules',
      rationale: 'Clarify bundler',
      priority: 'medium',
      content: {
        add: '## Architecture\n\n- Use Vite for bundling (NOT webpack)\n- me-web is a Vite CSR app',
        remove: null,
      },
      insightIds: [],
      skipped: false,
      skipReason: null,
    };

    const diff = buildDiff(raw, snapshot, 'CLAUDE.md', 'Architecture');

    expect(diff).not.toBeNull();
    expect(diff!.type).toBe('replace');
    expect(diff!.removedLines).not.toBeNull();
    // Should contain the real Architecture section content
    const removedTexts = diff!.removedLines!.map((l) => l.content);
    expect(removedTexts).toContain('# Architecture');
    expect(removedTexts).toContain('- Use Vite for bundling');
  });

  it('falls back to LLM remove text when section not found', () => {
    const snapshot = makeSnapshot();
    const raw: LlmSuggestion = {
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: 'Nonexistent Section',
      title: 'Some update',
      rationale: 'test',
      priority: 'low',
      content: {
        add: '- New rule',
        remove: '- Old rule that exists',
      },
      insightIds: [],
      skipped: false,
      skipReason: null,
    };

    const diff = buildDiff(raw, snapshot, 'CLAUDE.md', 'Nonexistent Section');

    expect(diff).not.toBeNull();
    // Falls back to using the LLM-provided remove text
    expect(diff!.type).toBe('replace');
  });

  it('falls back to add when no section and no remove text', () => {
    const snapshot = makeSnapshot();
    const raw: LlmSuggestion = {
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: 'Nonexistent Section',
      title: 'Some update',
      rationale: 'test',
      priority: 'low',
      content: {
        add: '- New rule',
        remove: null,
      },
      insightIds: [],
      skipped: false,
      skipReason: null,
    };

    const diff = buildDiff(raw, snapshot, 'CLAUDE.md', 'Nonexistent Section');

    expect(diff).not.toBeNull();
    expect(diff!.type).toBe('add');
    expect(diff!.removedLines).toBeNull();
  });

  it('section extraction stops at next heading of same level', () => {
    const snapshot = makeSnapshot();
    const raw: LlmSuggestion = {
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: 'Testing',
      title: 'Update testing',
      rationale: 'test',
      priority: 'medium',
      content: {
        add: '## Testing\n\n- Use vitest',
        remove: null,
      },
      insightIds: [],
      skipped: false,
      skipReason: null,
    };

    const diff = buildDiff(raw, snapshot, 'CLAUDE.md', 'Testing');

    expect(diff).not.toBeNull();
    // Should NOT include Deployment section content
    const removedTexts = diff!.removedLines!.map((l) => l.content);
    expect(removedTexts).not.toContain('# Deployment');
    expect(removedTexts).not.toContain('- Deploy to staging first');
  });
});
