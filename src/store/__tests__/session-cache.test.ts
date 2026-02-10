import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionInfo } from '../../session-reader/types.js';
import { getCachedSession, cacheSession } from '../session-cache.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let cacheDir: string;
let jsonlPath: string;

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'sess-001',
    projectPath: '/fake/project',
    projectPathEncoded: '-fake-project',
    filePath: '/fake/project/session.jsonl',
    fileSize: 1024,
    messageCount: 10,
    userMessageCount: 5,
    assistantMessageCount: 5,
    toolUseCount: 3,
    firstTimestamp: '2025-01-01T00:00:00Z',
    lastTimestamp: '2025-01-01T01:00:00Z',
    durationMinutes: 60,
    summary: 'Test session',
    messages: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-cache-test-'));
  cacheDir = join(tempDir, 'store');
  await mkdir(join(cacheDir, 'cache', 'sessions'), { recursive: true });
  jsonlPath = join(tempDir, 'session.jsonl');
  await writeFile(jsonlPath, '{"type":"summary"}\n', 'utf-8');
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getCachedSession
// ---------------------------------------------------------------------------

describe('getCachedSession', () => {
  it('returns null when no cache file exists', async () => {
    const result = await getCachedSession(cacheDir, 'sess-001', jsonlPath);
    expect(result).toBeNull();
  });

  it('returns cached data when JSONL file is unchanged (same mtime)', async () => {
    // Ensure the JSONL file's mtime is clearly in the past
    const pastTime = new Date(Date.now() - 10_000);
    await utimes(jsonlPath, pastTime, pastTime);

    const session = makeSession();
    await cacheSession(cacheDir, session);

    const result = await getCachedSession(cacheDir, 'sess-001', jsonlPath);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sess-001');
    expect(result!.summary).toBe('Test session');
  });

  it('does not include _cachedAt in the returned data', async () => {
    const pastTime = new Date(Date.now() - 10_000);
    await utimes(jsonlPath, pastTime, pastTime);

    const session = makeSession();
    await cacheSession(cacheDir, session);

    const result = await getCachedSession(cacheDir, 'sess-001', jsonlPath);
    expect(result).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((result as any)._cachedAt).toBeUndefined();
  });

  it('returns null when JSONL file has been modified after caching', async () => {
    const session = makeSession();
    await cacheSession(cacheDir, session);

    // Touch the JSONL file to update its mtime to the future
    const futureTime = new Date(Date.now() + 10_000);
    await utimes(jsonlPath, futureTime, futureTime);

    const result = await getCachedSession(cacheDir, 'sess-001', jsonlPath);
    expect(result).toBeNull();
  });

  it('returns null when JSONL file does not exist', async () => {
    const session = makeSession();
    await cacheSession(cacheDir, session);

    const missingJsonl = join(tempDir, 'missing.jsonl');
    const result = await getCachedSession(cacheDir, 'sess-001', missingJsonl);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cacheSession
// ---------------------------------------------------------------------------

describe('cacheSession', () => {
  it('saves to correct path: cache/sessions/<id>.json', async () => {
    const session = makeSession({ sessionId: 'abc-123' });
    await cacheSession(cacheDir, session);

    const expectedPath = join(cacheDir, 'cache', 'sessions', 'abc-123.json');
    const raw = await readFile(expectedPath, 'utf-8');
    const data = JSON.parse(raw);

    expect(data.sessionId).toBe('abc-123');
    expect(data._cachedAt).toBeTypeOf('number');
  });

  it('includes _cachedAt timestamp in the cached file', async () => {
    const before = Date.now();
    const session = makeSession();
    await cacheSession(cacheDir, session);
    const after = Date.now();

    const cachePath = join(cacheDir, 'cache', 'sessions', 'sess-001.json');
    const data = JSON.parse(await readFile(cachePath, 'utf-8'));

    expect(data._cachedAt).toBeGreaterThanOrEqual(before);
    expect(data._cachedAt).toBeLessThanOrEqual(after);
  });

  it('preserves all session fields in the cache', async () => {
    const session = makeSession({
      messageCount: 42,
      summary: 'Detailed session',
    });
    await cacheSession(cacheDir, session);

    const cachePath = join(cacheDir, 'cache', 'sessions', 'sess-001.json');
    const data = JSON.parse(await readFile(cachePath, 'utf-8'));

    expect(data.messageCount).toBe(42);
    expect(data.summary).toBe('Detailed session');
    expect(data.projectPath).toBe('/fake/project');
  });
});
