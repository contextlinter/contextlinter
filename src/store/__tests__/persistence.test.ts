import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson, initStoreDir } from '../persistence.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'persistence-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readJson
// ---------------------------------------------------------------------------

describe('readJson', () => {
  it('returns null for non-existent file', async () => {
    const result = await readJson(join(tempDir, 'does-not-exist.json'));
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    const filePath = join(tempDir, 'bad.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, '{ not valid json !!!', 'utf-8');

    const result = await readJson(filePath);
    expect(result).toBeNull();
  });

  it('parses valid JSON correctly', async () => {
    const filePath = join(tempDir, 'good.json');
    const data = { name: 'test', count: 42, nested: { ok: true } };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, JSON.stringify(data), 'utf-8');

    const result = await readJson<typeof data>(filePath);
    expect(result).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// writeJson
// ---------------------------------------------------------------------------

describe('writeJson', () => {
  it('creates parent directories if needed', async () => {
    const filePath = join(tempDir, 'a', 'b', 'c', 'data.json');
    await writeJson(filePath, { hello: 'world' });

    const content = await readFile(filePath, 'utf-8');
    expect(JSON.parse(content)).toEqual({ hello: 'world' });
  });

  it('writes pretty-printed JSON with trailing newline', async () => {
    const filePath = join(tempDir, 'formatted.json');
    await writeJson(filePath, { key: 'value' });

    const raw = await readFile(filePath, 'utf-8');
    expect(raw).toBe(JSON.stringify({ key: 'value' }, null, 2) + '\n');
  });

  it('is atomic (temp file + rename, no leftover temp files)', async () => {
    const filePath = join(tempDir, 'atomic.json');
    await writeJson(filePath, { atomic: true });

    // The final file should exist
    const content = await readFile(filePath, 'utf-8');
    expect(JSON.parse(content)).toEqual({ atomic: true });

    // No .tmp- files should remain in the directory
    const files = await readdir(tempDir);
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('overwrites an existing file', async () => {
    const filePath = join(tempDir, 'overwrite.json');
    await writeJson(filePath, { version: 1 });
    await writeJson(filePath, { version: 2 });

    const result = await readJson<{ version: number }>(filePath);
    expect(result).toEqual({ version: 2 });
  });
});

// ---------------------------------------------------------------------------
// initStoreDir
// ---------------------------------------------------------------------------

describe('initStoreDir', () => {
  it('creates .contextlinter/ with .gitignore containing "*"', async () => {
    const storeDir = await initStoreDir(tempDir);

    expect(storeDir).toBe(join(tempDir, '.contextlinter'));

    const gitignore = await readFile(join(storeDir, '.gitignore'), 'utf-8');
    expect(gitignore).toBe('*\n');
  });

  it('creates cache/sessions and analysis subdirectories', async () => {
    const storeDir = await initStoreDir(tempDir);

    const sessionsCache = await stat(join(storeDir, 'cache', 'sessions'));
    expect(sessionsCache.isDirectory()).toBe(true);

    const analysisSessions = await stat(join(storeDir, 'analysis', 'sessions'));
    expect(analysisSessions.isDirectory()).toBe(true);

    const crossSession = await stat(join(storeDir, 'analysis', 'cross-session'));
    expect(crossSession.isDirectory()).toBe(true);
  });

  it('does not overwrite existing .gitignore', async () => {
    // First init
    await initStoreDir(tempDir);

    // Manually change the .gitignore
    const { writeFile } = await import('node:fs/promises');
    const gitignorePath = join(tempDir, '.contextlinter', '.gitignore');
    await writeFile(gitignorePath, 'custom-content\n', 'utf-8');

    // Second init should not overwrite
    await initStoreDir(tempDir);

    const gitignore = await readFile(gitignorePath, 'utf-8');
    expect(gitignore).toBe('custom-content\n');
  });
});
