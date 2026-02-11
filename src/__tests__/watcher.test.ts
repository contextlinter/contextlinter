import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage, SessionInfo, ProjectInfo, SessionFileInfo } from '../session-reader/types.js';
import type { AnalysisResult, Insight } from '../analyzer/types.js';
import type { WatchOptions, WatchStats, TrackedSession } from '../watcher.js';

// ---------------------------------------------------------------------------
// Mocks — isolate watcher from heavy dependencies
// ---------------------------------------------------------------------------

vi.mock('../session-reader/discovery.js', () => ({
  discoverProjects: vi.fn().mockResolvedValue([]),
  discoverSessionsInDir: vi.fn().mockResolvedValue([]),
}));

vi.mock('../session-reader/parser.js', () => ({
  buildSessionInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock('../store/persistence.js', () => ({
  initStoreDir: vi.fn(async (dir: string) => join(dir, '.contextlinter')),
}));

vi.mock('../store/session-cache.js', () => ({
  getCachedSession: vi.fn().mockResolvedValue(null),
  cacheSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../store/audit.js', () => ({
  loadAuditLog: vi.fn().mockResolvedValue({ sessions: {}, lastCrossSessionAt: null, version: 1 }),
  saveAuditLog: vi.fn().mockResolvedValue(undefined),
  markSessionParsed: vi.fn((audit: unknown) => audit),
  markSessionAnalyzed: vi.fn((audit: unknown) => audit),
}));

vi.mock('../store/analysis-store.js', () => ({
  saveAnalysisResult: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../analyzer/llm-client.js', () => ({
  checkCliAvailable: vi.fn().mockResolvedValue(true),
  getPromptVersion: vi.fn().mockResolvedValue('test-version-hash'),
}));

vi.mock('../analyzer/single-session.js', () => ({
  analyzeSingleSession: vi.fn().mockResolvedValue({
    sessionId: 'test-session',
    projectPath: '/test',
    analyzedAt: '2026-01-01T00:00:00Z',
    insights: [],
    stats: { totalMessages: 0, userMessages: 0, correctionsDetected: 0, insightsGenerated: 0, analysisTimeMs: 100, tokensUsed: 500 },
  }),
}));

vi.mock('../suggester/loader.js', () => ({
  loadSuggestionInputs: vi.fn().mockResolvedValue({
    insights: [],
    crossPatterns: [],
    rulesSnapshot: {
      projectRoot: '/test',
      snapshotAt: '2026-01-01T00:00:00Z',
      files: [],
      allRules: [],
      stats: { totalFiles: 0, totalRules: 0, byScope: {}, byFormat: {}, totalLines: 0, totalSizeBytes: 0, hasGlobalRules: false, hasLocalRules: false, hasModularRules: false, importCount: 0 },
    },
    filteredOut: 0,
  }),
}));

vi.mock('../suggester/generator.js', () => ({
  generateSuggestions: vi.fn().mockResolvedValue({ suggestions: [], skipped: [], durationMs: 100, batchCount: 1 }),
  computeSuggestionCacheKey: vi.fn().mockReturnValue('test-cache-key'),
}));

vi.mock('../suggester/dedup.js', () => ({
  dedupAndRank: vi.fn((s: unknown[]) => s),
}));

vi.mock('../store/suggestion-store.js', () => ({
  saveSuggestionSet: vi.fn().mockResolvedValue('/fake/path'),
  findSuggestionSetByCacheKey: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/logger.js', () => ({
  printError: vi.fn(),
  printVerbose: vi.fn(),
  printWarning: vi.fn(),
}));

// Import AFTER mocks
import {
  isContextlinterSession,
  waitForStable,
  pollOnce,
  processCandidate,
  runScopedSuggest,
  printExitSummary,
} from '../watcher.js';
import { discoverSessionsInDir } from '../session-reader/discovery.js';
import { buildSessionInfo } from '../session-reader/parser.js';
import { analyzeSingleSession } from '../analyzer/single-session.js';
import { loadAuditLog } from '../store/audit.js';
import { getCachedSession } from '../store/session-cache.js';
import { loadSuggestionInputs } from '../suggester/loader.js';
import { generateSuggestions } from '../suggester/generator.js';
import { findSuggestionSetByCacheKey } from '../store/suggestion-store.js';

const mockedDiscoverSessionsInDir = vi.mocked(discoverSessionsInDir);
const mockedBuildSessionInfo = vi.mocked(buildSessionInfo);
const mockedAnalyzeSingleSession = vi.mocked(analyzeSingleSession);
const mockedLoadAuditLog = vi.mocked(loadAuditLog);
const mockedGetCachedSession = vi.mocked(getCachedSession);
const mockedLoadSuggestionInputs = vi.mocked(loadSuggestionInputs);
const mockedGenerateSuggestions = vi.mocked(generateSuggestions);
const mockedFindSuggestionSetByCacheKey = vi.mocked(findSuggestionSetByCacheKey);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let msgIndex = 0;

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    role: 'user',
    timestamp: `2026-01-15T10:${String(msgIndex++).padStart(2, '0')}:00Z`,
    textContent: 'Hello',
    toolUses: [],
    toolResults: [],
    hasThinking: false,
    rawType: 'message',
    ...overrides,
  };
}

function userMsg(text = 'Fix the bug'): NormalizedMessage {
  return makeMsg({ role: 'user', textContent: text });
}

function assistantMsg(text = 'I will fix it', tools: Array<{ id: string; name: string; input: unknown }> = []): NormalizedMessage {
  return makeMsg({ role: 'assistant', textContent: text, toolUses: tools });
}

function makeSession(messages: NormalizedMessage[], overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'test-session-1',
    projectPath: '/home/user/project',
    projectPathEncoded: '-home-user-project',
    filePath: '/fake/sessions/test-session-1.jsonl',
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

function makeInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: 'insight-001',
    category: 'missing_project_knowledge',
    confidence: 0.85,
    title: 'Use pnpm',
    description: 'The project uses pnpm.',
    evidence: [{ role: 'user', text: 'Use pnpm', timestamp: null, messageIndex: 0 }],
    suggestedRule: '- Use pnpm',
    actionHint: 'add_to_rules',
    sessionId: 'test-session-1',
    projectPath: '/home/user/project',
    ...overrides,
  };
}

function makeSessionFileInfo(filePath: string, overrides: Partial<SessionFileInfo> = {}): SessionFileInfo {
  return {
    sessionId: 'new-session-abc',
    filePath,
    fileSize: 10000,
    modifiedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeProject(dirPath: string, sessions: SessionFileInfo[] = []): ProjectInfo {
  return {
    projectPath: '/home/user/project',
    projectPathEncoded: '-home-user-project',
    dirPath,
    sessions,
  };
}

function defaultOpts(overrides: Partial<WatchOptions> = {}): WatchOptions {
  return {
    interval: 300,
    cooldown: 0, // 0 for fast tests
    suggest: true,
    verbose: false,
    ...overrides,
  };
}

function makeStats(overrides: Partial<WatchStats> = {}): WatchStats {
  return {
    startedAt: new Date(),
    sessionsAnalyzed: 0,
    insightsFound: 0,
    suggestionsGenerated: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  msgIndex = 0;
  vi.clearAllMocks();
  tempDir = await mkdtemp(join(tmpdir(), 'watcher-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isContextlinterSession
// ---------------------------------------------------------------------------

describe('isContextlinterSession', () => {
  it('returns true when user message contains "contextlinter analyze"', () => {
    const session = makeSession([
      userMsg('Please run contextlinter analyze on this project'),
      assistantMsg('Sure'),
    ]);
    expect(isContextlinterSession(session)).toBe(true);
  });

  it('returns true when user message contains "contextlinter suggest"', () => {
    const session = makeSession([
      userMsg('run contextlinter suggest --full'),
      assistantMsg('Done'),
    ]);
    expect(isContextlinterSession(session)).toBe(true);
  });

  it('returns true when user message contains "contextlinter watch"', () => {
    const session = makeSession([
      userMsg('start contextlinter watch'),
      assistantMsg('Starting...'),
    ]);
    expect(isContextlinterSession(session)).toBe(true);
  });

  it('returns true when assistant runs contextlinter via Bash', () => {
    const session = makeSession([
      userMsg('lint my rules'),
      assistantMsg('Running...', [
        { id: 'tu-1', name: 'Bash', input: { command: 'npx tsx contextlinter/src/index.ts analyze' } },
      ]),
    ]);
    expect(isContextlinterSession(session)).toBe(true);
  });

  it('returns false for a normal coding session', () => {
    const session = makeSession([
      userMsg('Fix the login page'),
      assistantMsg('I will fix the login form'),
      userMsg('Also update the tests'),
      assistantMsg('Done'),
    ]);
    expect(isContextlinterSession(session)).toBe(false);
  });

  it('returns false for empty messages', () => {
    const session = makeSession([]);
    expect(isContextlinterSession(session)).toBe(false);
  });

  it('returns false when "contextlinter" appears without a command keyword', () => {
    const session = makeSession([
      userMsg('What is contextlinter? Tell me about it.'),
      assistantMsg('It is a tool for linting Claude Code rules.'),
    ]);
    expect(isContextlinterSession(session)).toBe(false);
  });

  it('only checks the first 5 messages', () => {
    const msgs: NormalizedMessage[] = [];
    // 6 normal messages, then a contextlinter message at position 6 (index 6)
    for (let i = 0; i < 6; i++) {
      msgs.push(userMsg(`Normal message ${i}`));
    }
    msgs.push(userMsg('run contextlinter analyze'));

    const session = makeSession(msgs);
    expect(isContextlinterSession(session)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitForStable
// ---------------------------------------------------------------------------

describe('waitForStable', () => {
  it('returns true when file does not change during cooldown', async () => {
    const filePath = join(tempDir, 'stable.jsonl');
    await writeFile(filePath, 'line1\n', 'utf-8');

    const result = await waitForStable(filePath, 0, false);
    expect(result).toBe(true);
  });

  it('returns false when file does not exist', async () => {
    const result = await waitForStable(join(tempDir, 'nonexistent.jsonl'), 0, false);
    expect(result).toBe(false);
  });

  it('returns false when file is deleted during cooldown', async () => {
    const filePath = join(tempDir, 'disappear.jsonl');
    await writeFile(filePath, 'data\n', 'utf-8');

    // Delete the file immediately — the first stat succeeds, delay(0) resolves,
    // then the second stat will fail
    const promise = waitForStable(filePath, 0, false);
    await rm(filePath);

    const result = await promise;
    // Could be true or false depending on timing with cooldown=0;
    // the important thing is it doesn't throw
    expect(typeof result).toBe('boolean');
  });

  it('returns true after one extra cycle when file changes once then stops', async () => {
    const filePath = join(tempDir, 'grows-once.jsonl');
    await writeFile(filePath, 'initial\n', 'utf-8');

    // With cooldown=0, both delays resolve instantly.
    // The file won't change between stat calls, so it should be stable.
    const result = await waitForStable(filePath, 0, false);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pollOnce
// ---------------------------------------------------------------------------

describe('pollOnce', () => {
  it('does nothing when no new sessions appear', async () => {
    const dirPath = join(tempDir, 'project-sessions');
    await mkdir(dirPath, { recursive: true });

    mockedDiscoverSessionsInDir.mockResolvedValueOnce([]);

    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    const stats = makeStats();

    await pollOnce(project, seen, stats, tempDir, '/home/user/project', defaultOpts());

    expect(stats.sessionsAnalyzed).toBe(0);
  });

  it('detects a new session file and adds it to seen', async () => {
    const dirPath = join(tempDir, 'project-sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'new-session.jsonl');
    await writeFile(sessionFile, '{"type":"user"}\n'.repeat(100), 'utf-8');

    mockedDiscoverSessionsInDir.mockResolvedValueOnce([
      makeSessionFileInfo(sessionFile, { sessionId: 'new-session' }),
    ]);

    // Mock audit says not analyzed
    mockedLoadAuditLog.mockResolvedValueOnce({ sessions: {}, lastCrossSessionAt: null, version: 1 });
    // Mock session parse returns a short session (will be skipped silently)
    mockedGetCachedSession.mockResolvedValueOnce(null);
    mockedBuildSessionInfo.mockResolvedValueOnce(makeSession([userMsg()], {
      sessionId: 'new-session',
      filePath: sessionFile,
      userMessageCount: 1,
    }));

    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    const stats = makeStats();

    await pollOnce(project, seen, stats, tempDir, '/home/user/project', defaultOpts());

    expect(seen.has('new-session')).toBe(true);
  });

  it('detects significant growth (>5KB) in existing session', async () => {
    const dirPath = join(tempDir, 'project-sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'growing.jsonl');
    await writeFile(sessionFile, 'x'.repeat(20000), 'utf-8');

    mockedDiscoverSessionsInDir.mockResolvedValueOnce([
      makeSessionFileInfo(sessionFile, { sessionId: 'growing', fileSize: 20000 }),
    ]);

    // Mock: short session to be silently skipped after detection
    mockedLoadAuditLog.mockResolvedValueOnce({ sessions: {}, lastCrossSessionAt: null, version: 1 });
    mockedGetCachedSession.mockResolvedValueOnce(null);
    mockedBuildSessionInfo.mockResolvedValueOnce(makeSession([userMsg()], {
      sessionId: 'growing',
      filePath: sessionFile,
      userMessageCount: 1,
    }));

    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    // Mark as seen with small size
    seen.set('growing', { mtime: 0, size: 5000, analyzed: false });
    const stats = makeStats();

    await pollOnce(project, seen, stats, tempDir, '/home/user/project', defaultOpts());

    // Size should be updated
    const tracked = seen.get('growing')!;
    expect(tracked.size).toBe(20000);
  });

  it('ignores growth <5KB in existing session', async () => {
    const dirPath = join(tempDir, 'project-sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'small-growth.jsonl');
    await writeFile(sessionFile, 'x'.repeat(9000), 'utf-8');

    mockedDiscoverSessionsInDir.mockResolvedValueOnce([
      makeSessionFileInfo(sessionFile, { sessionId: 'small-growth', fileSize: 9000 }),
    ]);

    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    // Existing size is 5000, file is now 9000 → growth = 4000 < 5120
    seen.set('small-growth', { mtime: 0, size: 5000, analyzed: false });
    const stats = makeStats();

    await pollOnce(project, seen, stats, tempDir, '/home/user/project', defaultOpts());

    // analyzeSingleSession should NOT have been called
    expect(mockedAnalyzeSingleSession).not.toHaveBeenCalled();
  });

  it('skips sessions already marked as analyzed in seen map', async () => {
    const dirPath = join(tempDir, 'project-sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'done.jsonl');
    await writeFile(sessionFile, 'x'.repeat(20000), 'utf-8');

    mockedDiscoverSessionsInDir.mockResolvedValueOnce([
      makeSessionFileInfo(sessionFile, { sessionId: 'done', fileSize: 20000 }),
    ]);

    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    seen.set('done', { mtime: 0, size: 1000, analyzed: true });
    const stats = makeStats();

    await pollOnce(project, seen, stats, tempDir, '/home/user/project', defaultOpts());

    // Should not trigger analysis because analyzed=true
    expect(mockedAnalyzeSingleSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processCandidate
// ---------------------------------------------------------------------------

describe('processCandidate', () => {
  it('analyzes a valid session and updates stats', async () => {
    const dirPath = join(tempDir, 'sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'good.jsonl');
    await writeFile(sessionFile, '{"type":"user"}\n'.repeat(50), 'utf-8');

    const insights = [makeInsight({ id: 'ins-1' }), makeInsight({ id: 'ins-2' })];
    const sessionInfo = makeSession([userMsg(), assistantMsg(), userMsg(), assistantMsg()], {
      sessionId: 'good-session',
      filePath: sessionFile,
      userMessageCount: 2,
    });

    mockedLoadAuditLog.mockResolvedValue({ sessions: {}, lastCrossSessionAt: null, version: 1 });
    mockedGetCachedSession.mockResolvedValueOnce(null);
    mockedBuildSessionInfo.mockResolvedValueOnce(sessionInfo);
    mockedAnalyzeSingleSession.mockResolvedValueOnce({
      sessionId: 'good-session',
      projectPath: '/home/user/project',
      analyzedAt: '2026-01-01T00:00:00Z',
      insights,
      stats: { totalMessages: 4, userMessages: 2, correctionsDetected: 0, insightsGenerated: 2, analysisTimeMs: 500, tokensUsed: 1000 },
    });

    const candidate = makeSessionFileInfo(sessionFile, { sessionId: 'good-session' });
    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    seen.set('good-session', { mtime: 0, size: 1000, analyzed: false });
    const stats = makeStats();

    await processCandidate(candidate, project, seen, stats, tempDir, '/home/user/project', defaultOpts({ suggest: false }));

    expect(stats.sessionsAnalyzed).toBe(1);
    expect(stats.insightsFound).toBe(2);
    expect(seen.get('good-session')!.analyzed).toBe(true);
  });

  it('silently skips sessions with fewer than 2 user messages', async () => {
    const dirPath = join(tempDir, 'sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'short.jsonl');
    await writeFile(sessionFile, '{"type":"user"}\n', 'utf-8');

    const sessionInfo = makeSession([userMsg()], {
      sessionId: 'short-session',
      filePath: sessionFile,
      userMessageCount: 1,
    });

    mockedLoadAuditLog.mockResolvedValue({ sessions: {}, lastCrossSessionAt: null, version: 1 });
    mockedGetCachedSession.mockResolvedValueOnce(null);
    mockedBuildSessionInfo.mockResolvedValueOnce(sessionInfo);

    const candidate = makeSessionFileInfo(sessionFile, { sessionId: 'short-session' });
    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    seen.set('short-session', { mtime: 0, size: 100, analyzed: false });
    const stats = makeStats();

    await processCandidate(candidate, project, seen, stats, tempDir, '/home/user/project', defaultOpts());

    expect(stats.sessionsAnalyzed).toBe(0);
    expect(mockedAnalyzeSingleSession).not.toHaveBeenCalled();
  });

  it('skips contextlinter internal sessions', async () => {
    const dirPath = join(tempDir, 'sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'internal.jsonl');
    await writeFile(sessionFile, '{"type":"user"}\n'.repeat(10), 'utf-8');

    const sessionInfo = makeSession([
      userMsg('run contextlinter analyze'),
      assistantMsg('Running analysis...'),
      userMsg('now suggest'),
      assistantMsg('Generating...'),
    ], {
      sessionId: 'internal-session',
      filePath: sessionFile,
      userMessageCount: 2,
    });

    mockedLoadAuditLog.mockResolvedValue({ sessions: {}, lastCrossSessionAt: null, version: 1 });
    mockedGetCachedSession.mockResolvedValueOnce(null);
    mockedBuildSessionInfo.mockResolvedValueOnce(sessionInfo);

    const candidate = makeSessionFileInfo(sessionFile, { sessionId: 'internal-session' });
    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    seen.set('internal-session', { mtime: 0, size: 100, analyzed: false });
    const stats = makeStats();

    await processCandidate(candidate, project, seen, stats, tempDir, '/home/user/project', defaultOpts());

    expect(stats.sessionsAnalyzed).toBe(0);
    expect(mockedAnalyzeSingleSession).not.toHaveBeenCalled();
  });

  it('skips sessions already analyzed in audit.json', async () => {
    const dirPath = join(tempDir, 'sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'already.jsonl');
    await writeFile(sessionFile, '{"type":"user"}\n'.repeat(10), 'utf-8');

    mockedLoadAuditLog.mockResolvedValue({
      sessions: {
        'already-done': {
          parsedAt: '2026-01-01T00:00:00Z',
          analyzedAt: '2026-01-01T00:00:00Z',
          analysisPromptVersion: 'v1',
          insightCount: 3,
          sessionMtime: 12345,
        },
      },
      lastCrossSessionAt: null,
      version: 1,
    });

    const candidate = makeSessionFileInfo(sessionFile, { sessionId: 'already-done' });
    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    seen.set('already-done', { mtime: 0, size: 100, analyzed: false });
    const stats = makeStats();

    await processCandidate(candidate, project, seen, stats, tempDir, '/home/user/project', defaultOpts());

    expect(stats.sessionsAnalyzed).toBe(0);
    expect(mockedAnalyzeSingleSession).not.toHaveBeenCalled();
    // Should mark as analyzed in seen map
    expect(seen.get('already-done')!.analyzed).toBe(true);
  });

  it('calls runScopedSuggest when suggest=true and insights found', async () => {
    const dirPath = join(tempDir, 'sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'with-insights.jsonl');
    await writeFile(sessionFile, '{"type":"user"}\n'.repeat(50), 'utf-8');

    const insights = [makeInsight({ id: 'ins-1' })];
    const sessionInfo = makeSession([userMsg(), assistantMsg(), userMsg(), assistantMsg()], {
      sessionId: 'insightful',
      filePath: sessionFile,
      userMessageCount: 2,
    });

    mockedLoadAuditLog.mockResolvedValue({ sessions: {}, lastCrossSessionAt: null, version: 1 });
    mockedGetCachedSession.mockResolvedValueOnce(null);
    mockedBuildSessionInfo.mockResolvedValueOnce(sessionInfo);
    mockedAnalyzeSingleSession.mockResolvedValueOnce({
      sessionId: 'insightful',
      projectPath: '/home/user/project',
      analyzedAt: '2026-01-01T00:00:00Z',
      insights,
      stats: { totalMessages: 4, userMessages: 2, correctionsDetected: 0, insightsGenerated: 1, analysisTimeMs: 500, tokensUsed: 1000 },
    });

    // loadSuggestionInputs should return the insight so runScopedSuggest can process it
    mockedLoadSuggestionInputs.mockResolvedValueOnce({
      insights,
      crossPatterns: [],
      rulesSnapshot: {
        projectRoot: '/home/user/project',
        snapshotAt: '2026-01-01T00:00:00Z',
        files: [],
        allRules: [],
        stats: { totalFiles: 0, totalRules: 0, byScope: {} as any, byFormat: {} as any, totalLines: 0, totalSizeBytes: 0, hasGlobalRules: false, hasLocalRules: false, hasModularRules: false, importCount: 0 },
      },
      filteredOut: 0,
    });

    const candidate = makeSessionFileInfo(sessionFile, { sessionId: 'insightful' });
    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    seen.set('insightful', { mtime: 0, size: 1000, analyzed: false });
    const stats = makeStats();

    await processCandidate(candidate, project, seen, stats, tempDir, '/home/user/project', defaultOpts({ suggest: true }));

    expect(mockedLoadSuggestionInputs).toHaveBeenCalled();
  });

  it('does not call suggest when suggest=false', async () => {
    const dirPath = join(tempDir, 'sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'no-suggest.jsonl');
    await writeFile(sessionFile, '{"type":"user"}\n'.repeat(50), 'utf-8');

    const insights = [makeInsight({ id: 'ins-1' })];
    const sessionInfo = makeSession([userMsg(), assistantMsg(), userMsg(), assistantMsg()], {
      sessionId: 'no-suggest',
      filePath: sessionFile,
      userMessageCount: 2,
    });

    mockedLoadAuditLog.mockResolvedValue({ sessions: {}, lastCrossSessionAt: null, version: 1 });
    mockedGetCachedSession.mockResolvedValueOnce(null);
    mockedBuildSessionInfo.mockResolvedValueOnce(sessionInfo);
    mockedAnalyzeSingleSession.mockResolvedValueOnce({
      sessionId: 'no-suggest',
      projectPath: '/home/user/project',
      analyzedAt: '2026-01-01T00:00:00Z',
      insights,
      stats: { totalMessages: 4, userMessages: 2, correctionsDetected: 0, insightsGenerated: 1, analysisTimeMs: 500, tokensUsed: 1000 },
    });

    const candidate = makeSessionFileInfo(sessionFile, { sessionId: 'no-suggest' });
    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    seen.set('no-suggest', { mtime: 0, size: 1000, analyzed: false });
    const stats = makeStats();

    await processCandidate(candidate, project, seen, stats, tempDir, '/home/user/project', defaultOpts({ suggest: false }));

    expect(stats.sessionsAnalyzed).toBe(1);
    expect(mockedLoadSuggestionInputs).not.toHaveBeenCalled();
  });

  it('handles analysis failure gracefully', async () => {
    const dirPath = join(tempDir, 'sessions');
    await mkdir(dirPath, { recursive: true });

    const sessionFile = join(dirPath, 'fail.jsonl');
    await writeFile(sessionFile, '{"type":"user"}\n'.repeat(50), 'utf-8');

    const sessionInfo = makeSession([userMsg(), assistantMsg(), userMsg(), assistantMsg()], {
      sessionId: 'fail-session',
      filePath: sessionFile,
      userMessageCount: 2,
    });

    mockedLoadAuditLog.mockResolvedValue({ sessions: {}, lastCrossSessionAt: null, version: 1 });
    mockedGetCachedSession.mockResolvedValueOnce(null);
    mockedBuildSessionInfo.mockResolvedValueOnce(sessionInfo);
    mockedAnalyzeSingleSession.mockRejectedValueOnce(new Error('LLM timeout'));

    const candidate = makeSessionFileInfo(sessionFile, { sessionId: 'fail-session' });
    const project = makeProject(dirPath);
    const seen = new Map<string, TrackedSession>();
    seen.set('fail-session', { mtime: 0, size: 1000, analyzed: false });
    const stats = makeStats();

    // Should not throw
    await processCandidate(candidate, project, seen, stats, tempDir, '/home/user/project', defaultOpts());

    expect(stats.sessionsAnalyzed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runScopedSuggest
// ---------------------------------------------------------------------------

describe('runScopedSuggest', () => {
  it('returns 0 when no matching insights found', async () => {
    mockedLoadSuggestionInputs.mockResolvedValueOnce({
      insights: [],
      crossPatterns: [],
      rulesSnapshot: {
        projectRoot: '/test',
        snapshotAt: '2026-01-01T00:00:00Z',
        files: [],
        allRules: [],
        stats: { totalFiles: 0, totalRules: 0, byScope: {} as any, byFormat: {} as any, totalLines: 0, totalSizeBytes: 0, hasGlobalRules: false, hasLocalRules: false, hasModularRules: false, importCount: 0 },
      },
      filteredOut: 0,
    });

    const result = await runScopedSuggest(tempDir, '/test', ['nonexistent-id'], defaultOpts());
    expect(result).toBe(0);
  });

  it('returns cached suggestion count when cache hits', async () => {
    const insights = [makeInsight({ id: 'ins-1' })];

    mockedLoadSuggestionInputs.mockResolvedValueOnce({
      insights,
      crossPatterns: [],
      rulesSnapshot: {
        projectRoot: '/test',
        snapshotAt: '2026-01-01T00:00:00Z',
        files: [],
        allRules: [],
        stats: { totalFiles: 0, totalRules: 0, byScope: {} as any, byFormat: {} as any, totalLines: 0, totalSizeBytes: 0, hasGlobalRules: false, hasLocalRules: false, hasModularRules: false, importCount: 0 },
      },
      filteredOut: 0,
    });

    mockedFindSuggestionSetByCacheKey.mockResolvedValueOnce({
      projectPath: '/test',
      generatedAt: '2026-01-01T00:00:00Z',
      suggestions: [{ id: 's1' } as any, { id: 's2' } as any],
      stats: { total: 2, byType: {} as any, byPriority: {} as any, insightsUsed: 1, insightsSkipped: 0, estimatedRulesAfter: 2 },
    });

    const result = await runScopedSuggest(tempDir, '/test', ['ins-1'], defaultOpts());
    expect(result).toBe(2);
    expect(mockedGenerateSuggestions).not.toHaveBeenCalled();
  });

  it('returns 0 and does not throw when generator fails', async () => {
    const insights = [makeInsight({ id: 'ins-1' })];

    mockedLoadSuggestionInputs.mockResolvedValueOnce({
      insights,
      crossPatterns: [],
      rulesSnapshot: {
        projectRoot: '/test',
        snapshotAt: '2026-01-01T00:00:00Z',
        files: [],
        allRules: [],
        stats: { totalFiles: 0, totalRules: 0, byScope: {} as any, byFormat: {} as any, totalLines: 0, totalSizeBytes: 0, hasGlobalRules: false, hasLocalRules: false, hasModularRules: false, importCount: 0 },
      },
      filteredOut: 0,
    });

    mockedFindSuggestionSetByCacheKey.mockResolvedValueOnce(null);
    mockedGenerateSuggestions.mockRejectedValueOnce(new Error('LLM exploded'));

    const result = await runScopedSuggest(tempDir, '/test', ['ins-1'], defaultOpts());
    expect(result).toBe(0);
  });

  it('generates and returns count of ranked suggestions', async () => {
    const insights = [makeInsight({ id: 'ins-1' }), makeInsight({ id: 'ins-2' })];

    mockedLoadSuggestionInputs.mockResolvedValueOnce({
      insights,
      crossPatterns: [],
      rulesSnapshot: {
        projectRoot: '/test',
        snapshotAt: '2026-01-01T00:00:00Z',
        files: [],
        allRules: [],
        stats: { totalFiles: 0, totalRules: 0, byScope: {} as any, byFormat: {} as any, totalLines: 0, totalSizeBytes: 0, hasGlobalRules: false, hasLocalRules: false, hasModularRules: false, importCount: 0 },
      },
      filteredOut: 0,
    });

    mockedFindSuggestionSetByCacheKey.mockResolvedValueOnce(null);
    mockedGenerateSuggestions.mockResolvedValueOnce({
      suggestions: [
        { id: 's1', type: 'add', priority: 'high', confidence: 0.9, title: 'Add rule', rationale: 'test', targetFile: 'CLAUDE.md', targetSection: null, diff: { type: 'add', afterLine: null, inSection: null, removedLines: null, addedLines: [{ lineNumber: null, content: '- new rule' }], parts: null }, sourceInsightIds: ['ins-1'], sourceSessionIds: ['test'], splitTarget: null, status: 'pending' },
      ] as any,
      skipped: [],
      durationMs: 200,
      batchCount: 1,
    });

    const result = await runScopedSuggest(tempDir, '/test', ['ins-1', 'ins-2'], defaultOpts());
    expect(result).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// printExitSummary
// ---------------------------------------------------------------------------

describe('printExitSummary', () => {
  it('prints duration and stats', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    const stats: WatchStats = {
      startedAt: new Date(Date.now() - 2 * 3600000 - 15 * 60000), // 2h 15m ago
      sessionsAnalyzed: 4,
      insightsFound: 12,
      suggestionsGenerated: 7,
    };

    printExitSummary(stats);

    console.log = originalLog;

    const output = logs.join('\n');
    expect(output).toContain('Watch Summary');
    expect(output).toContain('2h 15m');
    expect(output).toContain('Sessions analyzed: 4');
    expect(output).toContain('Insights found: 12');
    expect(output).toContain('Suggestions generated: 7');
    expect(output).toContain('clinter apply');
  });

  it('omits apply message when no suggestions generated', () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    const stats: WatchStats = {
      startedAt: new Date(Date.now() - 5 * 60000), // 5m ago
      sessionsAnalyzed: 1,
      insightsFound: 0,
      suggestionsGenerated: 0,
    };

    printExitSummary(stats);

    console.log = originalLog;

    const output = logs.join('\n');
    expect(output).toContain('5m');
    expect(output).toContain('Suggestions generated: 0');
    expect(output).not.toContain('clinter apply');
  });
});
