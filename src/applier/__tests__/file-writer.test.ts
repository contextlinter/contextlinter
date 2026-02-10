import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Suggestion } from '../../suggester/types.js';
import {
  applySuggestion,
  resetBackupTracking,
  getContentPreview,
  relativePath,
} from '../file-writer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let projectRoot: string;
let storeDir: string;

/** Realistic CLAUDE.md content used across tests. */
const CLAUDE_MD = `# CLAUDE.md

Project rules for the AI assistant.

## Code Style

- Use TypeScript strict mode
- Prefer const over let
- Use single quotes for strings
- Maximum line length: 100 characters

## Testing

- Write unit tests for all new functions
- Use vitest as the test runner
- Aim for 80% coverage

## Git Workflow

- Use conventional commits
- Squash merge feature branches
- Always rebase before merging
`;

function makeSuggestion(overrides: Partial<Suggestion>): Suggestion {
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
      addedLines: null,
      parts: null,
    },
    splitTarget: null,
    sourceInsightIds: ['insight-1'],
    sourceSessionIds: ['session-1'],
    status: 'accepted',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'file-writer-test-'));
  projectRoot = join(tempDir, 'project');
  storeDir = join(tempDir, 'store');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(storeDir, { recursive: true });
  resetBackupTracking();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// applyAdd
// ---------------------------------------------------------------------------

describe('applyAdd', () => {
  it('creates a new file with content exactly once (no duplication)', async () => {
    const newRule = '- Always handle errors with try/catch\n- Log errors to stderr';
    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Always handle errors with try/catch' },
          { lineNumber: null, content: '- Log errors to stderr' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('created');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // Count occurrences — the bug was writing content twice
    const occurrences = content.split('- Always handle errors with try/catch').length - 1;
    expect(occurrences).toBe(1);

    expect(content).toContain(newRule);
  });

  it('creates parent directories if they do not exist', async () => {
    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: '.claude/rules/security.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '## Security' },
          { lineNumber: null, content: '' },
          { lineNumber: null, content: '- Never commit secrets or API keys' },
          { lineNumber: null, content: '- Use environment variables for sensitive config' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('created');

    const content = await readFile(
      join(projectRoot, '.claude', 'rules', 'security.md'),
      'utf-8',
    );
    expect(content).toContain('- Never commit secrets or API keys');
    expect(content).toContain('- Use environment variables for sensitive config');
  });

  it('appends to existing file in the correct section', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      targetSection: 'Testing',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: 'Testing',
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Mock external dependencies in unit tests' },
          { lineNumber: null, content: '- Use test fixtures for realistic data' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('modified');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // New rules should appear after existing Testing section content
    expect(content).toContain('- Mock external dependencies in unit tests');
    expect(content).toContain('- Use test fixtures for realistic data');

    // Existing testing rules should still be there
    expect(content).toContain('- Write unit tests for all new functions');
    expect(content).toContain('- Use vitest as the test runner');

    // The new content should be between Testing and Git Workflow sections
    const testingSectionIdx = content.indexOf('## Testing');
    const gitSectionIdx = content.indexOf('## Git Workflow');
    const newRuleIdx = content.indexOf('- Mock external dependencies in unit tests');
    expect(newRuleIdx).toBeGreaterThan(testingSectionIdx);
    expect(newRuleIdx).toBeLessThan(gitSectionIdx);
  });

  it('appends to end of file if target section does not exist', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      targetSection: 'Performance',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: 'Performance',
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Avoid N+1 queries' },
          { lineNumber: null, content: '- Use pagination for large result sets' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('modified');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // New section should be appended after existing content
    expect(content).toContain('## Performance');
    expect(content).toContain('- Avoid N+1 queries');

    // Should come after the last existing section
    const gitSectionIdx = content.indexOf('## Git Workflow');
    const perfSectionIdx = content.indexOf('## Performance');
    expect(perfSectionIdx).toBeGreaterThan(gitSectionIdx);

    // Original content should be untouched
    expect(content).toContain('## Code Style');
    expect(content).toContain('## Testing');
    expect(content).toContain('## Git Workflow');
  });

  it('does not duplicate content when applied twice', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      targetSection: 'Testing',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: 'Testing',
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Use snapshot tests for UI components' },
        ],
        parts: null,
      },
    });

    // Apply twice
    await applySuggestion(suggestion, projectRoot, storeDir);
    resetBackupTracking();
    await applySuggestion(suggestion, projectRoot, storeDir);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    const occurrences = content.split('- Use snapshot tests for UI components').length - 1;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyUpdate
// ---------------------------------------------------------------------------

describe('applyUpdate', () => {
  it('performs find-and-replace with valid removedLines', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: 'Code Style',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Code Style',
        removedLines: [
          { lineNumber: null, content: '- Maximum line length: 100 characters' },
        ],
        addedLines: [
          { lineNumber: null, content: '- Maximum line length: 120 characters' },
          { lineNumber: null, content: '- Use Prettier for auto-formatting' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('modified');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // Old rule should be gone
    expect(content).not.toContain('- Maximum line length: 100 characters');

    // New rules should be present
    expect(content).toContain('- Maximum line length: 120 characters');
    expect(content).toContain('- Use Prettier for auto-formatting');

    // Other sections should be untouched
    expect(content).toContain('## Testing');
    expect(content).toContain('- Write unit tests for all new functions');
  });

  it('falls back to section append when removedLines is empty', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: 'Code Style',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Code Style',
        removedLines: [],
        addedLines: [
          { lineNumber: null, content: '- Use ESLint with recommended rules' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('modified');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // New content should be appended into the Code Style section
    expect(content).toContain('- Use ESLint with recommended rules');

    // All original content should remain
    expect(content).toContain('- Use TypeScript strict mode');
    expect(content).toContain('- Prefer const over let');
    expect(content).toContain('- Maximum line length: 100 characters');
  });

  it('falls back to section append when removedLines is null', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: 'Git Workflow',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Git Workflow',
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Run CI checks before merging' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('- Run CI checks before merging');
    // Original Git Workflow rules should remain
    expect(content).toContain('- Use conventional commits');
    expect(content).toContain('- Squash merge feature branches');
  });

  it('falls back to end-of-file append when removedLines is null and no target section', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: null,
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- General rule appended at bottom' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('- General rule appended at bottom');

    // Should be at the very end
    const ruleIdx = content.indexOf('- General rule appended at bottom');
    const gitIdx = content.indexOf('## Git Workflow');
    expect(ruleIdx).toBeGreaterThan(gitIdx);
  });

  it('does not modify unrelated parts of the file', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'update',
      targetFile: 'CLAUDE.md',
      targetSection: 'Code Style',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Code Style',
        removedLines: [
          { lineNumber: null, content: '- Use single quotes for strings' },
        ],
        addedLines: [
          { lineNumber: null, content: '- Use double quotes for strings' },
        ],
        parts: null,
      },
    });

    await applySuggestion(suggestion, projectRoot, storeDir);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // The replacement should have occurred
    expect(content).not.toContain('- Use single quotes for strings');
    expect(content).toContain('- Use double quotes for strings');

    // Other Code Style rules untouched
    expect(content).toContain('- Use TypeScript strict mode');
    expect(content).toContain('- Prefer const over let');
    expect(content).toContain('- Maximum line length: 100 characters');

    // Testing section completely untouched
    expect(content).toContain('## Testing');
    expect(content).toContain('- Write unit tests for all new functions');
    expect(content).toContain('- Use vitest as the test runner');
    expect(content).toContain('- Aim for 80% coverage');

    // Git Workflow section completely untouched
    expect(content).toContain('## Git Workflow');
    expect(content).toContain('- Use conventional commits');
    expect(content).toContain('- Squash merge feature branches');
    expect(content).toContain('- Always rebase before merging');
  });

  it('creates the file when it does not exist (update on missing file)', async () => {
    const suggestion = makeSuggestion({
      type: 'update',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- Old rule that does not exist' },
        ],
        addedLines: [
          { lineNumber: null, content: '- Brand new rule for new file' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('created');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('- Brand new rule for new file');
  });
});

// ---------------------------------------------------------------------------
// applyRemove
// ---------------------------------------------------------------------------

describe('applyRemove', () => {
  it('removes exactly the specified text', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'remove',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'remove',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- Aim for 80% coverage' },
        ],
        addedLines: null,
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('modified');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // Removed text should be gone
    expect(content).not.toContain('- Aim for 80% coverage');

    // Adjacent rules in Testing section should remain
    expect(content).toContain('- Write unit tests for all new functions');
    expect(content).toContain('- Use vitest as the test runner');

    // Other sections remain intact
    expect(content).toContain('## Code Style');
    expect(content).toContain('## Git Workflow');
  });

  it('removes multi-line content', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'remove',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'remove',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- Squash merge feature branches' },
          { lineNumber: null, content: '- Always rebase before merging' },
        ],
        addedLines: null,
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).not.toContain('- Squash merge feature branches');
    expect(content).not.toContain('- Always rebase before merging');
    expect(content).toContain('- Use conventional commits');
  });

  it('returns error when file does not exist', async () => {
    const suggestion = makeSuggestion({
      type: 'remove',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'remove',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- Some rule' },
        ],
        addedLines: null,
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });
});

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

describe('backup', () => {
  it('creates a backup file before modifying an existing file', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- New rule to trigger backup' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.backupPath).not.toBeNull();
    expect(result.backupPath!).toContain(join(storeDir, 'backups'));

    // Backup should contain original content
    const backupContent = await readFile(result.backupPath!, 'utf-8');
    expect(backupContent).toBe(CLAUDE_MD);
  });

  it('does not create a backup when creating a new file', async () => {
    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: '.claude/rules/new-rules.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Brand new rule' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('created');
    // No backup needed for new files — backupPath should be null
    expect(result.backupPath).toBeNull();
  });

  it('only backs up each file once per session', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion1 = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- First new rule' },
        ],
        parts: null,
      },
    });

    const suggestion2 = makeSuggestion({
      id: 'test-002',
      type: 'update',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- Prefer const over let' },
        ],
        addedLines: [
          { lineNumber: null, content: '- Always use const' },
        ],
        parts: null,
      },
    });

    const result1 = await applySuggestion(suggestion1, projectRoot, storeDir);
    const result2 = await applySuggestion(suggestion2, projectRoot, storeDir);

    expect(result1.backupPath).not.toBeNull();
    expect(result2.backupPath).not.toBeNull();

    // The backup from the first call should contain the ORIGINAL content
    const backupContent = await readFile(result1.backupPath!, 'utf-8');
    expect(backupContent).toBe(CLAUDE_MD);
  });
});

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

describe('atomic write', () => {
  it('does not leave temp files after successful write', async () => {
    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Rule written atomically' },
        ],
        parts: null,
      },
    });

    await applySuggestion(suggestion, projectRoot, storeDir);

    // Check that no .tmp- files remain in the project directory
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(projectRoot);
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('writes the correct final content despite using temp+rename', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const expectedRule = '- Verify atomic write produces correct content';
    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: expectedRule },
        ],
        parts: null,
      },
    });

    await applySuggestion(suggestion, projectRoot, storeDir);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain(expectedRule);
    // Original content preserved
    expect(content).toContain('## Code Style');
  });
});

// ---------------------------------------------------------------------------
// Validation after write
// ---------------------------------------------------------------------------

describe('validation after write', () => {
  it('content is present in the file after applyAdd', async () => {
    const rules = [
      '- Validate all user inputs at the boundary',
      '- Sanitize HTML output to prevent XSS',
      '- Use parameterized queries to prevent SQL injection',
    ];
    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: '.claude/rules/security.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: rules.map((r) => ({ lineNumber: null, content: r })),
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(
      join(projectRoot, '.claude', 'rules', 'security.md'),
      'utf-8',
    );
    for (const rule of rules) {
      expect(content).toContain(rule);
    }
  });

  it('replacement content is present after applyUpdate', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const newRule = '- Target 90% code coverage on critical paths';
    const suggestion = makeSuggestion({
      type: 'update',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- Aim for 80% coverage' },
        ],
        addedLines: [
          { lineNumber: null, content: newRule },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain(newRule);
    expect(content).not.toContain('- Aim for 80% coverage');
  });
});

// ---------------------------------------------------------------------------
// editedContent override
// ---------------------------------------------------------------------------

describe('editedContent override', () => {
  it('uses editedContent instead of diff when provided to applyAdd', async () => {
    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Original content from diff' },
        ],
        parts: null,
      },
    });

    const editedContent = '- User-edited content overrides diff';
    const result = await applySuggestion(suggestion, projectRoot, storeDir, editedContent);

    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('- User-edited content overrides diff');
    expect(content).not.toContain('- Original content from diff');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('returns error when add suggestion has no content', async () => {
    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: null,
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No content to add');
  });

  it('returns error when remove text is not found in file', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'remove',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'remove',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- This rule does not exist in the file at all' },
        ],
        addedLines: null,
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not find text to remove');
  });

  it('handles fuzzy matching with whitespace differences', async () => {
    const contentWithWeirdSpacing = CLAUDE_MD.replace(
      '- Use single quotes for strings',
      '-  Use  single  quotes  for  strings',
    );
    await writeFile(join(projectRoot, 'CLAUDE.md'), contentWithWeirdSpacing, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'update',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- Use single quotes for strings' },
        ],
        addedLines: [
          { lineNumber: null, content: '- Use double quotes for strings' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('- Use double quotes for strings');
  });

  it('replace only affects first occurrence when text appears multiple times', async () => {
    const duplicated = `# Rules

## Section A

- Keep it simple
- Prefer readability

## Section B

- Keep it simple
- Prefer performance
`;
    await writeFile(join(projectRoot, 'CLAUDE.md'), duplicated, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'update',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- Keep it simple' },
        ],
        addedLines: [
          { lineNumber: null, content: '- Keep it minimal' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // String.replace replaces first occurrence only
    const minimalCount = content.split('- Keep it minimal').length - 1;
    const simpleCount = content.split('- Keep it simple').length - 1;
    expect(minimalCount).toBe(1);
    expect(simpleCount).toBe(1);
  });

  it('contentAlreadyPresent allows add when match is below 80% threshold', async () => {
    // File has 10 rules; new content shares only 1 of them — well below 80%
    const existing = `# CLAUDE.md

## Rules

- Rule one
- Rule two
- Rule three
- Rule four
- Rule five
- Rule six
- Rule seven
- Rule eight
- Rule nine
- Rule ten
`;
    await writeFile(join(projectRoot, 'CLAUDE.md'), existing, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Rule one' },
          { lineNumber: null, content: '- Brand new rule A' },
          { lineNumber: null, content: '- Brand new rule B' },
          { lineNumber: null, content: '- Brand new rule C' },
          { lineNumber: null, content: '- Brand new rule D' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    // Only 1/5 (20%) lines match — below 80%, so it should be added
    expect(result.success).toBe(true);
    expect(result.action).toBe('modified');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('- Brand new rule A');
  });
});

// ---------------------------------------------------------------------------
// applyConsolidate
// ---------------------------------------------------------------------------

describe('applyConsolidate', () => {
  it('removes old parts and adds new consolidated content', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'consolidate',
      targetFile: 'CLAUDE.md',
      targetSection: 'Code Style',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Code Style',
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Follow the unified style guide at docs/style.md' },
        ],
        parts: [
          {
            type: 'remove',
            afterLine: null,
            inSection: null,
            removedLines: [
              { lineNumber: null, content: '- Use TypeScript strict mode' },
              { lineNumber: null, content: '- Prefer const over let' },
            ],
            addedLines: null,
            parts: null,
          },
          {
            type: 'remove',
            afterLine: null,
            inSection: null,
            removedLines: [
              { lineNumber: null, content: '- Use single quotes for strings' },
            ],
            addedLines: null,
            parts: null,
          },
        ],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('modified');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // Old fragmented rules should be removed
    expect(content).not.toContain('- Use TypeScript strict mode');
    expect(content).not.toContain('- Prefer const over let');
    expect(content).not.toContain('- Use single quotes for strings');

    // New consolidated rule should be present
    expect(content).toContain('- Follow the unified style guide at docs/style.md');

    // Untouched content should remain
    expect(content).toContain('- Maximum line length: 100 characters');
    expect(content).toContain('## Testing');
    expect(content).toContain('## Git Workflow');
  });

  it('creates the file when it does not exist', async () => {
    const suggestion = makeSuggestion({
      type: 'consolidate',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Consolidated rule for brand-new file' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('created');

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('- Consolidated rule for brand-new file');
  });

  it('cleans up excessive blank lines left after removal', async () => {
    // Content with rules that, once removed, leave triple+ blank lines
    const spacedContent = `# Rules

## Code Style

- Rule to keep


- Rule to remove


## Other

- Stay here
`;
    await writeFile(join(projectRoot, 'CLAUDE.md'), spacedContent, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'consolidate',
      targetFile: 'CLAUDE.md',
      targetSection: null,
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Consolidated replacement' },
        ],
        parts: [
          {
            type: 'remove',
            afterLine: null,
            inSection: null,
            removedLines: [
              { lineNumber: null, content: '- Rule to remove' },
            ],
            addedLines: null,
            parts: null,
          },
        ],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // No runs of 3+ newlines should remain
    expect(content).not.toMatch(/\n{3,}/);
    expect(content).toContain('- Rule to keep');
    expect(content).toContain('- Consolidated replacement');
    expect(content).not.toContain('- Rule to remove');
  });

  it('appends to end of file when no targetSection', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'consolidate',
      targetFile: 'CLAUDE.md',
      targetSection: null,
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Appended consolidated rule' },
        ],
        parts: [
          {
            type: 'remove',
            afterLine: null,
            inSection: null,
            removedLines: [
              { lineNumber: null, content: '- Use conventional commits' },
            ],
            addedLines: null,
            parts: null,
          },
        ],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).not.toContain('- Use conventional commits');
    expect(content).toContain('- Appended consolidated rule');
  });
});

// ---------------------------------------------------------------------------
// insertInSection — nested headings
// ---------------------------------------------------------------------------

describe('insertInSection with nested headings', () => {
  const NESTED_MD = `# Project

## Code Style

Some intro text.

### Formatting

- Use Prettier
- Line length 100

### Naming

- camelCase for variables
- PascalCase for types

## Testing

- Write tests
`;

  it('inserts at end of section, before next same-level heading (not before subsection)', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), NESTED_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      targetSection: 'Code Style',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: 'Code Style',
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- New rule at end of Code Style' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // New rule should be within Code Style, before ## Testing
    const newRuleIdx = content.indexOf('- New rule at end of Code Style');
    const testingIdx = content.indexOf('## Testing');
    expect(newRuleIdx).toBeGreaterThan(0);
    expect(newRuleIdx).toBeLessThan(testingIdx);
  });

  it('inserts into a subsection correctly', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), NESTED_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      targetSection: 'Formatting',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: 'Formatting',
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Use tabs not spaces' },
        ],
        parts: null,
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');

    // New rule should be between ### Formatting and ### Naming
    const newRuleIdx = content.indexOf('- Use tabs not spaces');
    const formattingIdx = content.indexOf('### Formatting');
    const namingIdx = content.indexOf('### Naming');
    expect(newRuleIdx).toBeGreaterThan(formattingIdx);
    expect(newRuleIdx).toBeLessThan(namingIdx);
  });
});

// ---------------------------------------------------------------------------
// Multi-file backup tracking
// ---------------------------------------------------------------------------

describe('multi-file backup tracking', () => {
  it('backs up different files independently', async () => {
    const claudeMd = join(projectRoot, 'CLAUDE.md');
    const rulesDir = join(projectRoot, '.claude', 'rules');
    const securityMd = join(rulesDir, 'security.md');

    await writeFile(claudeMd, CLAUDE_MD, 'utf-8');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(securityMd, '# Security\n\n- No secrets in code\n', 'utf-8');

    const suggestion1 = makeSuggestion({
      type: 'add',
      targetFile: 'CLAUDE.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [{ lineNumber: null, content: '- New rule in CLAUDE.md' }],
        parts: null,
      },
    });

    const suggestion2 = makeSuggestion({
      id: 'test-002',
      type: 'add',
      targetFile: '.claude/rules/security.md',
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [{ lineNumber: null, content: '- New security rule' }],
        parts: null,
      },
    });

    const result1 = await applySuggestion(suggestion1, projectRoot, storeDir);
    const result2 = await applySuggestion(suggestion2, projectRoot, storeDir);

    // Both should have separate backups
    expect(result1.backupPath).not.toBeNull();
    expect(result2.backupPath).not.toBeNull();
    expect(result1.backupPath).not.toBe(result2.backupPath);

    // Each backup should contain the original content of the respective file
    const backup1 = await readFile(result1.backupPath!, 'utf-8');
    const backup2 = await readFile(result2.backupPath!, 'utf-8');
    expect(backup1).toBe(CLAUDE_MD);
    expect(backup2).toBe('# Security\n\n- No secrets in code\n');
  });
});

// ---------------------------------------------------------------------------
// getContentPreview
// ---------------------------------------------------------------------------

describe('getContentPreview', () => {
  it('returns editedContent when provided', () => {
    const suggestion = makeSuggestion({
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [{ lineNumber: null, content: '- From diff' }],
        parts: null,
      },
    });

    expect(getContentPreview(suggestion, '- Edited by user')).toBe('- Edited by user');
  });

  it('returns addedLines content from diff', () => {
    const suggestion = makeSuggestion({
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: [
          { lineNumber: null, content: '- Rule A' },
          { lineNumber: null, content: '- Rule B' },
        ],
        parts: null,
      },
    });

    expect(getContentPreview(suggestion)).toBe('- Rule A\n- Rule B');
  });

  it('returns removedLines content when no addedLines', () => {
    const suggestion = makeSuggestion({
      diff: {
        type: 'remove',
        afterLine: null,
        inSection: null,
        removedLines: [
          { lineNumber: null, content: '- Old rule to remove' },
        ],
        addedLines: null,
        parts: null,
      },
    });

    expect(getContentPreview(suggestion)).toBe('- Old rule to remove');
  });

  it('returns empty string when diff has no content', () => {
    const suggestion = makeSuggestion({
      diff: {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines: null,
        parts: null,
      },
    });

    expect(getContentPreview(suggestion)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// applySplit
// ---------------------------------------------------------------------------

describe('applySplit', () => {
  it('extracts a section from the source file and creates a new file', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'split',
      targetFile: 'CLAUDE.md',
      targetSection: 'Testing',
      splitTarget: '.claude/rules/testing.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Testing',
        removedLines: null,
        addedLines: null,
        parts: [
          {
            type: 'remove',
            afterLine: null,
            inSection: 'Testing',
            removedLines: [
              { lineNumber: 13, content: '## Testing' },
              { lineNumber: 14, content: '' },
              { lineNumber: 15, content: '- Write unit tests for all new functions' },
              { lineNumber: 16, content: '- Use vitest as the test runner' },
              { lineNumber: 17, content: '- Aim for 80% coverage' },
            ],
            addedLines: null,
            parts: null,
          },
          {
            type: 'add',
            afterLine: null,
            inSection: null,
            removedLines: null,
            addedLines: [
              { lineNumber: null, content: '# Testing' },
              { lineNumber: null, content: '(3 rules moved)' },
            ],
            parts: null,
          },
        ],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);

    expect(result.success).toBe(true);
    expect(result.action).toBe('modified');

    // Source file should no longer contain the Testing section
    const sourceContent = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(sourceContent).not.toContain('## Testing');
    expect(sourceContent).not.toContain('- Write unit tests for all new functions');
    expect(sourceContent).not.toContain('- Use vitest as the test runner');
    expect(sourceContent).not.toContain('- Aim for 80% coverage');

    // Other sections should remain intact
    expect(sourceContent).toContain('## Code Style');
    expect(sourceContent).toContain('- Use TypeScript strict mode');
    expect(sourceContent).toContain('## Git Workflow');
    expect(sourceContent).toContain('- Use conventional commits');

    // New file should exist with the extracted section
    const newContent = await readFile(
      join(projectRoot, '.claude', 'rules', 'testing.md'),
      'utf-8',
    );
    expect(newContent).toContain('# Testing');
    expect(newContent).toContain('- Write unit tests for all new functions');
    expect(newContent).toContain('- Use vitest as the test runner');
    expect(newContent).toContain('- Aim for 80% coverage');
  });

  it('adjusts heading levels when extracting a ## section', async () => {
    const contentWithSubsections = `# Project

## Architecture

### Frontend

- Use React with TypeScript
- State management with Zustand

### Backend

- Express.js REST API
- PostgreSQL database

## Other

- Misc rule
`;
    await writeFile(join(projectRoot, 'CLAUDE.md'), contentWithSubsections, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'split',
      targetFile: 'CLAUDE.md',
      targetSection: 'Architecture',
      splitTarget: '.claude/rules/architecture.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Architecture',
        removedLines: null,
        addedLines: null,
        parts: [],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const newContent = await readFile(
      join(projectRoot, '.claude', 'rules', 'architecture.md'),
      'utf-8',
    );

    // ## Architecture should become # Architecture
    expect(newContent).toContain('# Architecture');
    expect(newContent).not.toContain('## Architecture');

    // ### Frontend should become ## Frontend
    expect(newContent).toContain('## Frontend');
    expect(newContent).not.toContain('### Frontend');

    // ### Backend should become ## Backend
    expect(newContent).toContain('## Backend');
    expect(newContent).not.toContain('### Backend');

    // Source file should not contain Architecture section
    const sourceContent = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(sourceContent).not.toContain('## Architecture');
    expect(sourceContent).not.toContain('### Frontend');
    expect(sourceContent).toContain('## Other');
    expect(sourceContent).toContain('- Misc rule');
  });

  it('returns error when section is not found', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'split',
      targetFile: 'CLAUDE.md',
      targetSection: 'Nonexistent Section',
      splitTarget: '.claude/rules/nonexistent.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Nonexistent Section',
        removedLines: null,
        addedLines: null,
        parts: [],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Section "Nonexistent Section" not found');
  });

  it('returns error when no splitTarget is specified', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'split',
      targetFile: 'CLAUDE.md',
      targetSection: 'Testing',
      splitTarget: null,
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Testing',
        removedLines: null,
        addedLines: null,
        parts: [],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No split target');
  });

  it('returns error when file does not exist', async () => {
    const suggestion = makeSuggestion({
      type: 'split',
      targetFile: 'CLAUDE.md',
      targetSection: 'Testing',
      splitTarget: '.claude/rules/testing.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Testing',
        removedLines: null,
        addedLines: null,
        parts: [],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('creates a backup of the source file before splitting', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'split',
      targetFile: 'CLAUDE.md',
      targetSection: 'Git Workflow',
      splitTarget: '.claude/rules/git-workflow.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Git Workflow',
        removedLines: null,
        addedLines: null,
        parts: [],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);
    expect(result.backupPath).not.toBeNull();

    // Backup should contain the original content
    const backupContent = await readFile(result.backupPath!, 'utf-8');
    expect(backupContent).toBe(CLAUDE_MD);
  });

  it('cleans up extra blank lines after section removal', async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), CLAUDE_MD, 'utf-8');

    const suggestion = makeSuggestion({
      type: 'split',
      targetFile: 'CLAUDE.md',
      targetSection: 'Testing',
      splitTarget: '.claude/rules/testing.md',
      diff: {
        type: 'replace',
        afterLine: null,
        inSection: 'Testing',
        removedLines: null,
        addedLines: null,
        parts: [],
      },
    });

    const result = await applySuggestion(suggestion, projectRoot, storeDir);
    expect(result.success).toBe(true);

    const content = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf-8');
    // No runs of 3+ newlines should remain
    expect(content).not.toMatch(/\n{3,}/);
  });
});

// ---------------------------------------------------------------------------
// relativePath
// ---------------------------------------------------------------------------

describe('relativePath', () => {
  it('strips projectRoot prefix', () => {
    expect(relativePath('/home/user/project/CLAUDE.md', '/home/user/project'))
      .toBe('CLAUDE.md');
  });

  it('handles nested paths', () => {
    expect(relativePath('/home/user/project/.claude/rules/foo.md', '/home/user/project'))
      .toBe('.claude/rules/foo.md');
  });

  it('returns full path when it does not start with projectRoot', () => {
    expect(relativePath('/other/path/file.md', '/home/user/project'))
      .toBe('/other/path/file.md');
  });
});
