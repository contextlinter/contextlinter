import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { discoverRulesFiles, type DiscoveredFile } from '../discovery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let root: string;

async function createFile(relativePath: string, content = '# Rules\n') {
  const fullPath = join(root, relativePath);
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content);
}

function paths(files: DiscoveredFile[]): string[] {
  return files.map((f) => f.relativePath).sort();
}

function scopes(files: DiscoveredFile[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const f of files) {
    result[f.relativePath] = f.scope;
  }
  return result;
}

beforeEach(async () => {
  const dir = join(tmpdir(), `discovery-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  // Resolve symlinks (macOS /tmp → /private/var/...) so paths match realpath() in source
  root = await realpath(dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Root-level files
// ---------------------------------------------------------------------------

describe('root-level files', () => {
  it('finds CLAUDE.md in project root', async () => {
    await createFile('CLAUDE.md');

    const files = await discoverRulesFiles(root);

    expect(paths(files)).toContain('CLAUDE.md');
  });

  it('finds CLAUDE.local.md in project root', async () => {
    await createFile('CLAUDE.local.md');

    const files = await discoverRulesFiles(root);

    expect(paths(files)).toContain('CLAUDE.local.md');
  });

  it('finds .claude/CLAUDE.md', async () => {
    await createFile('.claude/CLAUDE.md');

    const files = await discoverRulesFiles(root);

    expect(paths(files)).toContain('.claude/CLAUDE.md');
  });
});

// ---------------------------------------------------------------------------
// Modular rules in .claude/rules/
// ---------------------------------------------------------------------------

describe('modular rules (.claude/rules/)', () => {
  it('finds all .md files in .claude/rules/', async () => {
    await createFile('.claude/rules/style.md');
    await createFile('.claude/rules/testing.md');
    await createFile('.claude/rules/deploy.md');

    const files = await discoverRulesFiles(root);
    const rulePaths = paths(files);

    expect(rulePaths).toContain('.claude/rules/deploy.md');
    expect(rulePaths).toContain('.claude/rules/style.md');
    expect(rulePaths).toContain('.claude/rules/testing.md');
  });

  it('ignores non-.md files in .claude/rules/', async () => {
    await createFile('.claude/rules/valid.md');
    await createFile('.claude/rules/config.json');
    await createFile('.claude/rules/notes.txt');
    await createFile('.claude/rules/data.yaml');

    const files = await discoverRulesFiles(root);
    const rulePaths = paths(files);

    expect(rulePaths).toContain('.claude/rules/valid.md');
    expect(rulePaths).not.toContain('.claude/rules/config.json');
    expect(rulePaths).not.toContain('.claude/rules/notes.txt');
    expect(rulePaths).not.toContain('.claude/rules/data.yaml');
  });
});

// ---------------------------------------------------------------------------
// Subdirectory CLAUDE.md
// ---------------------------------------------------------------------------

describe('subdirectory CLAUDE.md', () => {
  it('finds CLAUDE.md in subdirectories', async () => {
    await createFile('packages/ui/CLAUDE.md');
    await createFile('apps/web/CLAUDE.md');

    const files = await discoverRulesFiles(root);
    const rulePaths = paths(files);

    expect(rulePaths).toContain('packages/ui/CLAUDE.md');
    expect(rulePaths).toContain('apps/web/CLAUDE.md');
  });

  it('subdirectory scan limited to max 3 levels deep', async () => {
    // depth 1 — should be found
    await createFile('a/CLAUDE.md');
    // depth 2 — should be found
    await createFile('a/b/CLAUDE.md');
    // depth 3 — should be found
    await createFile('a/b/c/CLAUDE.md');
    // depth 4 — should NOT be found (exceeds 3 levels)
    await createFile('a/b/c/d/CLAUDE.md');

    const files = await discoverRulesFiles(root);
    const rulePaths = paths(files);

    expect(rulePaths).toContain('a/CLAUDE.md');
    expect(rulePaths).toContain('a/b/CLAUDE.md');
    expect(rulePaths).toContain('a/b/c/CLAUDE.md');
    expect(rulePaths).not.toContain('a/b/c/d/CLAUDE.md');
  });

  it('assigns scope "subdirectory" to subdirectory CLAUDE.md files', async () => {
    await createFile('packages/core/CLAUDE.md');

    const files = await discoverRulesFiles(root);
    const found = files.find((f) => f.relativePath === 'packages/core/CLAUDE.md');

    expect(found).toBeDefined();
    expect(found!.scope).toBe('subdirectory');
  });
});

// ---------------------------------------------------------------------------
// Ignored directories
// ---------------------------------------------------------------------------

describe('ignored directories', () => {
  it('ignores node_modules/', async () => {
    await createFile('node_modules/some-pkg/CLAUDE.md');

    const files = await discoverRulesFiles(root);

    expect(paths(files)).not.toContain('node_modules/some-pkg/CLAUDE.md');
  });

  it('ignores .git/', async () => {
    await createFile('.git/hooks/CLAUDE.md');

    const files = await discoverRulesFiles(root);

    expect(paths(files)).not.toContain('.git/hooks/CLAUDE.md');
  });

  it('ignores dist/ and build/', async () => {
    await createFile('dist/CLAUDE.md');
    await createFile('build/CLAUDE.md');

    const files = await discoverRulesFiles(root);
    const rulePaths = paths(files);

    expect(rulePaths).not.toContain('dist/CLAUDE.md');
    expect(rulePaths).not.toContain('build/CLAUDE.md');
  });

  it('ignores dot-prefixed directories (except .claude)', async () => {
    await createFile('.hidden/CLAUDE.md');
    await createFile('.claude/CLAUDE.md');

    const files = await discoverRulesFiles(root);
    const rulePaths = paths(files);

    expect(rulePaths).not.toContain('.hidden/CLAUDE.md');
    expect(rulePaths).toContain('.claude/CLAUDE.md');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it("doesn't crash when directories don't exist", async () => {
    const nonExistent = join(root, 'nope', 'not-here');

    const files = await discoverRulesFiles(nonExistent);

    expect(files).toBeInstanceOf(Array);
  });

  it('returns empty array for project with no rules files', async () => {
    // root exists but has no CLAUDE.md files
    await createFile('src/index.ts', 'console.log("hello")');

    const files = await discoverRulesFiles(root);
    // Filter out global ~/.claude/CLAUDE.md if it exists on the test machine
    const nonGlobal = files.filter((f) => f.scope !== 'global');

    expect(nonGlobal).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scope assignment
// ---------------------------------------------------------------------------

describe('scope assignment', () => {
  it('assigns "project" scope to CLAUDE.md', async () => {
    await createFile('CLAUDE.md');

    const files = await discoverRulesFiles(root);
    const s = scopes(files);

    expect(s['CLAUDE.md']).toBe('project');
  });

  it('assigns "project_local" scope to CLAUDE.local.md', async () => {
    await createFile('CLAUDE.local.md');

    const files = await discoverRulesFiles(root);
    const s = scopes(files);

    expect(s['CLAUDE.local.md']).toBe('project_local');
  });

  it('assigns "project" scope to .claude/CLAUDE.md', async () => {
    await createFile('.claude/CLAUDE.md');

    const files = await discoverRulesFiles(root);
    const s = scopes(files);

    expect(s['.claude/CLAUDE.md']).toBe('project');
  });

  it('assigns "project" scope to modular rules files', async () => {
    await createFile('.claude/rules/testing.md');

    const files = await discoverRulesFiles(root);
    const s = scopes(files);

    expect(s['.claude/rules/testing.md']).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// DiscoveredFile shape
// ---------------------------------------------------------------------------

describe('DiscoveredFile metadata', () => {
  it('includes lastModified and sizeBytes', async () => {
    await createFile('CLAUDE.md', '# My Rules\n\n- Do stuff\n');

    const files = await discoverRulesFiles(root);
    const found = files.find((f) => f.relativePath === 'CLAUDE.md');

    expect(found).toBeDefined();
    expect(found!.lastModified).toBeGreaterThan(0);
    expect(found!.sizeBytes).toBeGreaterThan(0);
  });

  it('path is absolute', async () => {
    await createFile('CLAUDE.md');

    const files = await discoverRulesFiles(root);
    const found = files.find((f) => f.relativePath === 'CLAUDE.md');

    expect(found!.path).toMatch(/^\//);
  });
});

// ---------------------------------------------------------------------------
// Combined discovery
// ---------------------------------------------------------------------------

describe('combined discovery', () => {
  it('discovers all rule file types in one pass', async () => {
    await createFile('CLAUDE.md');
    await createFile('CLAUDE.local.md');
    await createFile('.claude/CLAUDE.md');
    await createFile('.claude/rules/style.md');
    await createFile('.claude/rules/testing.md');
    await createFile('packages/ui/CLAUDE.md');

    const files = await discoverRulesFiles(root);
    // Filter out global ~/.claude/CLAUDE.md if present
    const nonGlobal = files.filter((f) => f.scope !== 'global');
    const rulePaths = nonGlobal.map((f) => f.relativePath).sort();

    expect(rulePaths).toEqual([
      '.claude/CLAUDE.md',
      '.claude/rules/style.md',
      '.claude/rules/testing.md',
      'CLAUDE.local.md',
      'CLAUDE.md',
      'packages/ui/CLAUDE.md',
    ]);
  });

  it('does not produce duplicates', async () => {
    await createFile('CLAUDE.md');

    const files = await discoverRulesFiles(root);
    const claudePaths = files.filter((f) => f.relativePath === 'CLAUDE.md');

    expect(claudePaths).toHaveLength(1);
  });
});
