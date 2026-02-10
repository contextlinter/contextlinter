import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { findProjectRoot } from '../paths.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'paths-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findProjectRoot
// ---------------------------------------------------------------------------

describe('findProjectRoot', () => {
  it('finds root by .git directory', async () => {
    const projectDir = join(tempDir, 'my-project');
    const nestedDir = join(projectDir, 'src', 'utils');

    await mkdir(join(projectDir, '.git'), { recursive: true });
    await mkdir(nestedDir, { recursive: true });

    const root = await findProjectRoot(nestedDir);
    expect(root).toBe(projectDir);
  });

  it('finds root by package.json', async () => {
    const projectDir = join(tempDir, 'my-project');
    const nestedDir = join(projectDir, 'src', 'components');

    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(projectDir, 'package.json'), '{}', 'utf-8');

    const root = await findProjectRoot(nestedDir);
    expect(root).toBe(projectDir);
  });

  it('finds root by CLAUDE.md', async () => {
    const projectDir = join(tempDir, 'my-project');
    const nestedDir = join(projectDir, 'lib', 'deep');

    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(projectDir, 'CLAUDE.md'), '# Rules', 'utf-8');

    const root = await findProjectRoot(nestedDir);
    expect(root).toBe(projectDir);
  });

  it('returns null when no marker is found', async () => {
    // tempDir has no .git, package.json, or CLAUDE.md anywhere up to /
    const emptyDir = join(tempDir, 'empty');
    await mkdir(emptyDir, { recursive: true });

    const root = await findProjectRoot(emptyDir);
    expect(root).toBeNull();
  });

  it('stops at filesystem root (does not loop infinitely)', async () => {
    // If it didn't stop, this would hang forever.
    // Using a deeply nested empty dir to exercise the upward walk.
    const deepDir = join(tempDir, 'a', 'b', 'c', 'd', 'e');
    await mkdir(deepDir, { recursive: true });

    const root = await findProjectRoot(deepDir);
    // Should terminate and return null (or a root if a marker happens
    // to exist above tempDir — either way, no hang).
    expect(root === null || typeof root === 'string').toBe(true);
  });

  it('returns startDir itself when it contains a marker', async () => {
    await writeFile(join(tempDir, 'package.json'), '{}', 'utf-8');

    const root = await findProjectRoot(tempDir);
    expect(root).toBe(tempDir);
  });

  it('prefers the nearest marker when multiple exist', async () => {
    // outer/package.json  and  outer/inner/.git
    const outer = join(tempDir, 'outer');
    const inner = join(outer, 'inner');
    const deep = join(inner, 'src');

    await mkdir(deep, { recursive: true });
    await writeFile(join(outer, 'package.json'), '{}', 'utf-8');
    await mkdir(join(inner, '.git'), { recursive: true });

    const root = await findProjectRoot(deep);
    expect(root).toBe(inner);
  });
});
