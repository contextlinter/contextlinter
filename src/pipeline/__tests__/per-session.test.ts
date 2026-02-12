import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionInfo, NormalizedMessage } from '../../session-reader/types.js';
import type { AnalysisResult, Insight, CrossSessionPattern } from '../../analyzer/types.js';
import type { RulesSnapshot } from '../../rules-reader/types.js';
import type { Suggestion, LlmSuggestion } from '../../suggester/types.js';
import type { SessionPipelineResult } from '../types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../analyzer/single-session.js', () => ({
  analyzeAndSuggestSession: vi.fn(),
}));

vi.mock('../../analyzer/cross-session.js', () => ({
  synthesizeCrossSessions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../suggester/generator.js', () => ({
  generateSessionSuggestions: vi.fn().mockResolvedValue({
    suggestions: [],
    skipped: [],
    durationMs: 100,
    batchCount: 1,
  }),
  buildSuggestion: vi.fn((raw: LlmSuggestion) => {
    if (!raw || raw.skipped) return null;
    const id = `sug-${raw.title.replace(/\s+/g, '-').toLowerCase().slice(0, 40)}`;
    return {
      id,
      type: raw.type ?? 'add',
      priority: raw.priority ?? 'medium',
      confidence: 0.8,
      title: raw.title,
      rationale: raw.rationale ?? 'Test rationale',
      targetFile: raw.targetFile ?? 'CLAUDE.md',
      targetSection: raw.targetSection ?? 'Testing',
      splitTarget: null,
      diff: {
        type: raw.type ?? 'add',
        afterLine: 10,
        inSection: raw.targetSection ?? 'Testing',
        removedLines: null,
        addedLines: [{ lineNumber: 11, content: 'test rule' }],
        parts: null,
      },
      sourceInsightIds: raw.insightIds ?? [],
      sourceSessionIds: [],
      status: 'pending',
    } as Suggestion;
  }),
  buildInsightSessionMap: vi.fn().mockReturnValue(new Map()),
}));

// Keep real dedup for testing incremental dedup behavior
// vi.mock('../../suggester/dedup.js') — intentionally NOT mocked

vi.mock('../../store/analysis-store.js', () => ({
  saveAnalysisResult: vi.fn().mockResolvedValue(undefined),
  saveCrossSessionPatterns: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../store/audit.js', () => ({
  loadAuditLog: vi.fn().mockResolvedValue({ sessions: {}, lastCrossSessionAt: null, version: 1 }),
  saveAuditLog: vi.fn().mockResolvedValue(undefined),
  markSessionAnalyzed: vi.fn((audit: unknown) => audit),
  markCrossSessionDone: vi.fn((audit: unknown) => audit),
}));

vi.mock('../../store/suggestion-store.js', () => ({
  saveSuggestionSet: vi.fn().mockResolvedValue('/fake/path'),
}));

vi.mock('../../analyzer/llm-client.js', () => ({
  getPromptVersion: vi.fn().mockResolvedValue('test-version-hash'),
}));

vi.mock('../../utils/logger.js', () => ({
  printWarning: vi.fn(),
  printVerbose: vi.fn(),
}));

// Import after mocks
import { runPerSessionPipeline } from '../per-session.js';
import { analyzeAndSuggestSession } from '../../analyzer/single-session.js';
import { synthesizeCrossSessions } from '../../analyzer/cross-session.js';
import { generateSessionSuggestions } from '../../suggester/generator.js';
import { saveSuggestionSet } from '../../store/suggestion-store.js';

const mockedCombined = vi.mocked(analyzeAndSuggestSession);
const mockedCrossSession = vi.mocked(synthesizeCrossSessions);
const mockedGenerate = vi.mocked(generateSessionSuggestions);
const mockedSaveSuggestionSet = vi.mocked(saveSuggestionSet);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let msgIdx = 0;

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    role: 'user',
    timestamp: `2026-01-15T10:${String(msgIdx++).padStart(2, '0')}:00Z`,
    textContent: 'Hello',
    toolUses: [],
    toolResults: [],
    hasThinking: false,
    rawType: 'message',
    ...overrides,
  };
}

function makeSession(id: string, userMsgs = 5): SessionInfo {
  const messages: NormalizedMessage[] = [];
  for (let i = 0; i < userMsgs; i++) {
    messages.push(makeMsg({ role: 'user', textContent: `Message ${i}` }));
    messages.push(makeMsg({ role: 'assistant', textContent: `Reply ${i}` }));
  }
  return {
    sessionId: id,
    projectPath: '/test/project',
    projectPathEncoded: '-test-project',
    filePath: `/fake/sessions/${id}.jsonl`,
    fileSize: 50000,
    messageCount: messages.length,
    userMessageCount: userMsgs,
    assistantMessageCount: userMsgs,
    toolUseCount: 0,
    firstTimestamp: messages[0]?.timestamp ?? null,
    lastTimestamp: messages.at(-1)?.timestamp ?? null,
    durationMinutes: 30,
    summary: null,
    messages,
  };
}

function makeInsight(id: string, sessionId: string, title = 'Test insight'): Insight {
  return {
    id,
    category: 'repeated_correction',
    confidence: 0.8,
    title,
    description: 'Test description',
    evidence: [],
    suggestedRule: 'Test rule',
    actionHint: 'add_to_rules',
    sessionId,
    projectPath: '/test/project',
  };
}

function makeAnalysisResult(sessionId: string, insights: Insight[]): AnalysisResult {
  return {
    sessionId,
    projectPath: '/test/project',
    analyzedAt: new Date().toISOString(),
    insights,
    stats: {
      totalMessages: 10,
      userMessages: 5,
      correctionsDetected: insights.length,
      insightsGenerated: insights.length,
      analysisTimeMs: 5000,
      tokensUsed: 1000,
    },
  };
}

function makeLlmSuggestion(
  title: string,
  insightIds: string[] = [],
  overrides: Partial<LlmSuggestion> = {},
): LlmSuggestion {
  return {
    type: 'add',
    targetFile: 'CLAUDE.md',
    targetSection: 'Testing',
    title,
    rationale: 'Test rationale',
    priority: 'medium',
    content: { add: 'test rule', remove: null },
    insightIds,
    skipped: false,
    skipReason: null,
    ...overrides,
  };
}

function makeSuggestion(id: string, title: string, sessionId: string): Suggestion {
  return {
    id,
    type: 'add',
    priority: 'medium',
    confidence: 0.8,
    title,
    rationale: 'Test rationale',
    targetFile: 'CLAUDE.md',
    targetSection: 'Testing',
    splitTarget: null,
    diff: {
      type: 'add',
      afterLine: 10,
      inSection: 'Testing',
      removedLines: null,
      addedLines: [{ lineNumber: 11, content: 'test rule' }],
      parts: null,
    },
    sourceInsightIds: [`insight-${id}`],
    sourceSessionIds: [sessionId],
    status: 'pending',
  };
}

const defaultRulesSnapshot: RulesSnapshot = {
  projectRoot: '/test/project',
  snapshotAt: '2026-01-01T00:00:00Z',
  files: [],
  allRules: [],
  stats: {
    totalFiles: 0,
    totalRules: 0,
    byScope: { project: 0, global: 0, project_local: 0, subdirectory: 0 },
    byFormat: { heading_section: 0, bullet_point: 0, paragraph: 0, command: 0, emphatic: 0 },
    totalLines: 0,
    totalSizeBytes: 0,
    hasGlobalRules: false,
    hasLocalRules: false,
    hasModularRules: false,
    importCount: 0,
  },
};

const defaultOpts = {
  verbose: false,
  noCross: true,
  dryRun: false,
  force: false,
  minMessages: 2,
  yes: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  msgIdx = 0;
});

describe('runPerSessionPipeline', () => {
  it('processes a single session and produces suggestions', async () => {
    const session = makeSession('session-1');
    const insight = makeInsight('i1', 'session-1');
    const analysisResult = makeAnalysisResult('session-1', [insight]);
    const rawSug = makeLlmSuggestion('Add pnpm rule', ['i1']);

    mockedCombined.mockResolvedValueOnce({
      analysisResult,
      suggestions: [rawSug],
    });

    const completedSessions: SessionPipelineResult[] = [];

    const result = await runPerSessionPipeline(
      [session],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
      { onSessionComplete: (r) => completedSessions.push(r) },
    );

    expect(result.stats.sessionsAnalyzed).toBe(1);
    expect(result.stats.insightsFound).toBe(1);
    expect(result.allSuggestions).toHaveLength(1);
    expect(result.allSuggestions[0].title).toBe('Add pnpm rule');

    expect(completedSessions).toHaveLength(1);
    expect(completedSessions[0].sessionId).toBe('session-1');
    expect(completedSessions[0].suggestions).toHaveLength(1);
  });

  it('deduplicates suggestions across sessions', async () => {
    const session1 = makeSession('session-1');
    const session2 = makeSession('session-2');

    const insight1 = makeInsight('i1', 'session-1', 'Use pnpm not npm');
    const insight2 = makeInsight('i2', 'session-2', 'Use pnpm instead of npm');

    const result1 = makeAnalysisResult('session-1', [insight1]);
    const result2 = makeAnalysisResult('session-2', [insight2]);

    // Same-ish titles, same target — dedup may merge
    const raw1 = makeLlmSuggestion('Use pnpm not npm', ['i1']);
    const raw2 = makeLlmSuggestion('Use pnpm instead of npm', ['i2']);

    mockedCombined
      .mockResolvedValueOnce({ analysisResult: result1, suggestions: [raw1] })
      .mockResolvedValueOnce({ analysisResult: result2, suggestions: [raw2] });

    const completedSessions: SessionPipelineResult[] = [];

    const result = await runPerSessionPipeline(
      [session1, session2],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
      { onSessionComplete: (r) => completedSessions.push(r) },
    );

    // Both titles are similar — dedup should keep at most 2, possibly fewer
    expect(result.allSuggestions.length).toBeLessThanOrEqual(2);
    expect(completedSessions).toHaveLength(2);
  });

  it('runs cross-session synthesis when enabled and 2+ sessions', async () => {
    const session1 = makeSession('session-1');
    const session2 = makeSession('session-2');

    const insight1 = makeInsight('i1', 'session-1', 'Insight A');
    const insight2 = makeInsight('i2', 'session-2', 'Insight B');

    const result1 = makeAnalysisResult('session-1', [insight1]);
    const result2 = makeAnalysisResult('session-2', [insight2]);

    mockedCombined
      .mockResolvedValueOnce({ analysisResult: result1, suggestions: [] })
      .mockResolvedValueOnce({ analysisResult: result2, suggestions: [] });

    const crossPattern: CrossSessionPattern = {
      id: 'cp1',
      category: 'repeated_correction',
      confidence: 0.9,
      title: 'Cross pattern',
      description: 'Found across sessions',
      occurrences: [
        { sessionId: 'session-1', insightId: 'i1', timestamp: null },
        { sessionId: 'session-2', insightId: 'i2', timestamp: null },
      ],
      suggestedRule: 'Cross rule',
      actionHint: 'add_to_rules',
      projectPath: '/test/project',
    };

    mockedCrossSession.mockResolvedValueOnce([crossPattern]);

    let crossCallbackFired = false;
    const result = await runPerSessionPipeline(
      [session1, session2],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      { ...defaultOpts, noCross: false },
      {
        onCrossSessionComplete: () => { crossCallbackFired = true; },
      },
    );

    expect(mockedCrossSession).toHaveBeenCalledOnce();
    expect(crossCallbackFired).toBe(true);
    expect(result.crossPatterns).toHaveLength(1);
  });

  it('returns empty result when no sessions provided', async () => {
    const result = await runPerSessionPipeline(
      [],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
    );

    expect(result.stats.sessionsAnalyzed).toBe(0);
    expect(result.allSuggestions).toEqual([]);
    expect(mockedCombined).not.toHaveBeenCalled();
  });

  it('skips sessions with zero insights', async () => {
    const session = makeSession('session-1');
    const emptyResult = makeAnalysisResult('session-1', []);

    mockedCombined.mockResolvedValueOnce({
      analysisResult: emptyResult,
      suggestions: [],
    });

    const result = await runPerSessionPipeline(
      [session],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
    );

    expect(result.stats.sessionsAnalyzed).toBe(1);
    expect(result.stats.insightsFound).toBe(0);
    // generateSessionSuggestions is only for existingResults / cross-session
    expect(mockedGenerate).not.toHaveBeenCalled();
    expect(result.allSuggestions).toEqual([]);
  });

  it('continues when one session analysis fails', async () => {
    const session1 = makeSession('session-1');
    const session2 = makeSession('session-2');

    const insight2 = makeInsight('i2', 'session-2');
    const result2 = makeAnalysisResult('session-2', [insight2]);
    const rawSug = makeLlmSuggestion('Add rule', ['i2']);

    mockedCombined
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce({ analysisResult: result2, suggestions: [rawSug] });

    const result = await runPerSessionPipeline(
      [session1, session2],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
    );

    // Session 1 failed, session 2 succeeded
    expect(result.stats.sessionsAnalyzed).toBe(1);
    expect(result.allSuggestions).toHaveLength(1);
    expect(result.sessionResults).toHaveLength(2);
    expect(result.sessionResults[0].insights).toEqual([]);
    expect(result.sessionResults[1].insights).toHaveLength(1);
  });

  it('accumulates suggestions from multiple sessions via incremental dedup', async () => {
    const session1 = makeSession('session-1');
    const session2 = makeSession('session-2');
    const session3 = makeSession('session-3');

    const ins1 = makeInsight('i1', 'session-1', 'Insight 1');
    const ins2 = makeInsight('i2', 'session-2', 'Insight 2');
    const ins3 = makeInsight('i3', 'session-3', 'Insight 3');

    const res1 = makeAnalysisResult('session-1', [ins1]);
    const res2 = makeAnalysisResult('session-2', [ins2]);
    const res3 = makeAnalysisResult('session-3', [ins3]);

    // Different titles and sections to avoid dedup merging
    const raw1 = makeLlmSuggestion('Always use pnpm package manager', ['i1'], { targetSection: 'Build' });
    const raw2 = makeLlmSuggestion('Document vitest testing conventions', ['i2'], { targetSection: 'Testing' });
    const raw3 = makeLlmSuggestion('Prefer Zustand over Redux for state', ['i3'], { targetSection: 'Architecture' });

    mockedCombined
      .mockResolvedValueOnce({ analysisResult: res1, suggestions: [raw1] })
      .mockResolvedValueOnce({ analysisResult: res2, suggestions: [raw2] })
      .mockResolvedValueOnce({ analysisResult: res3, suggestions: [raw3] });

    const completedSessions: SessionPipelineResult[] = [];

    const result = await runPerSessionPipeline(
      [session1, session2, session3],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
      { onSessionComplete: (r) => completedSessions.push(r) },
    );

    // All 3 suggestions should be accumulated (no dedup since titles are distinct)
    expect(result.allSuggestions).toHaveLength(3);
    expect(completedSessions).toHaveLength(3);
    // Each session reports its new suggestions
    expect(completedSessions[0].suggestions).toHaveLength(1);
    expect(completedSessions[1].suggestions).toHaveLength(1);
    expect(completedSessions[2].suggestions).toHaveLength(1);
  });

  it('does not call LLM in dry run mode', async () => {
    const session = makeSession('session-1');

    const completedSessions: SessionPipelineResult[] = [];

    const result = await runPerSessionPipeline(
      [session],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      { ...defaultOpts, dryRun: true },
      { onSessionComplete: (r) => completedSessions.push(r) },
    );

    expect(mockedCombined).not.toHaveBeenCalled();
    expect(mockedGenerate).not.toHaveBeenCalled();
    expect(completedSessions).toHaveLength(1);
    expect(result.sessionResults).toHaveLength(1);
  });

  it('saves final suggestion set to disk', async () => {
    const session = makeSession('session-1');
    const insight = makeInsight('i1', 'session-1');
    const analysisResult = makeAnalysisResult('session-1', [insight]);
    const rawSug = makeLlmSuggestion('Add rule', ['i1']);

    mockedCombined.mockResolvedValueOnce({
      analysisResult,
      suggestions: [rawSug],
    });

    await runPerSessionPipeline(
      [session],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
    );

    expect(mockedSaveSuggestionSet).toHaveBeenCalledOnce();
    const savedSet = mockedSaveSuggestionSet.mock.calls[0][1];
    expect(savedSet.suggestions).toHaveLength(1);
    expect(savedSet.projectPath).toBe('/test/project');
  });

  it('does not save suggestion set when no suggestions generated', async () => {
    const session = makeSession('session-1');
    const emptyResult = makeAnalysisResult('session-1', []);

    mockedCombined.mockResolvedValueOnce({
      analysisResult: emptyResult,
      suggestions: [],
    });

    await runPerSessionPipeline(
      [session],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
    );

    expect(mockedSaveSuggestionSet).not.toHaveBeenCalled();
  });

  it('fires onSessionAnalyzed callback after each analysis', async () => {
    const session1 = makeSession('session-1');
    const session2 = makeSession('session-2');

    const ins1 = makeInsight('i1', 'session-1');
    const ins2a = makeInsight('i2a', 'session-2');
    const ins2b = makeInsight('i2b', 'session-2');

    mockedCombined
      .mockResolvedValueOnce({
        analysisResult: makeAnalysisResult('session-1', [ins1]),
        suggestions: [],
      })
      .mockResolvedValueOnce({
        analysisResult: makeAnalysisResult('session-2', [ins2a, ins2b]),
        suggestions: [],
      });

    const analyzed: Array<{ sessionId: string; insightsFound: number }> = [];

    await runPerSessionPipeline(
      [session1, session2],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
      {
        onSessionAnalyzed: (sessionId, insightsFound) => {
          analyzed.push({ sessionId, insightsFound });
        },
      },
    );

    expect(analyzed).toHaveLength(2);
    expect(analyzed[0].insightsFound).toBe(1);
    expect(analyzed[1].insightsFound).toBe(2);
  });

  it('routes warnings to onWarning callback when provided', async () => {
    const session = makeSession('session-1');

    mockedCombined.mockRejectedValueOnce(new Error('LLM timeout'));

    const warnings: string[] = [];

    await runPerSessionPipeline(
      [session],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
      { onWarning: (msg) => warnings.push(msg) },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Analysis failed');
    expect(warnings[0]).toContain('LLM timeout');
  });

  it('generates suggestions for existingResults without re-analyzing', async () => {
    // Simulate: no new sessions to analyze, but 2 already-analyzed sessions
    const existingInsight1 = makeInsight('ei1', 'existing-1', 'Old insight 1');
    const existingInsight2 = makeInsight('ei2', 'existing-2', 'Old insight 2');
    const existingResult1 = makeAnalysisResult('existing-1', [existingInsight1]);
    const existingResult2 = makeAnalysisResult('existing-2', [existingInsight2]);

    const sug1 = { ...makeSuggestion('es1', 'Always use pnpm for packages', 'existing-1'), targetSection: 'Build' };
    const sug2 = { ...makeSuggestion('es2', 'Prefer vitest over jest for testing', 'existing-2'), targetSection: 'Testing' };

    mockedGenerate
      .mockResolvedValueOnce({ suggestions: [sug1], skipped: [], durationMs: 50, batchCount: 1 })
      .mockResolvedValueOnce({ suggestions: [sug2], skipped: [], durationMs: 50, batchCount: 1 });

    const completedSessions: SessionPipelineResult[] = [];

    const result = await runPerSessionPipeline(
      [],  // no new sessions
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
      { onSessionComplete: (r) => completedSessions.push(r) },
      [existingResult1, existingResult2],  // pre-analyzed
    );

    // No combined analysis calls
    expect(mockedCombined).not.toHaveBeenCalled();
    // But suggest was called for each existing result
    expect(mockedGenerate).toHaveBeenCalledTimes(2);
    expect(result.allSuggestions).toHaveLength(2);
    expect(completedSessions).toHaveLength(2);
    expect(completedSessions[0].sessionId).toBe('existing-1');
    expect(completedSessions[1].sessionId).toBe('existing-2');
  });

  it('combines existingResults and new sessions', async () => {
    // 1 existing + 1 new session
    const existingInsight = makeInsight('ei1', 'existing-1', 'Old insight');
    const existingResult = makeAnalysisResult('existing-1', [existingInsight]);
    const existingSug = { ...makeSuggestion('es1', 'Existing session rule', 'existing-1'), targetSection: 'Existing' };

    const newSession = makeSession('new-1');
    const newInsight = makeInsight('ni1', 'new-1', 'New insight');
    const newResult = makeAnalysisResult('new-1', [newInsight]);
    const rawNewSug = makeLlmSuggestion('New session rule', ['ni1'], { targetSection: 'New' });

    // existing result uses generateSessionSuggestions
    mockedGenerate.mockResolvedValueOnce({
      suggestions: [existingSug],
      skipped: [],
      durationMs: 50,
      batchCount: 1,
    });

    // new session uses combined analyzeAndSuggest
    mockedCombined.mockResolvedValueOnce({
      analysisResult: newResult,
      suggestions: [rawNewSug],
    });

    const result = await runPerSessionPipeline(
      [newSession],
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
      undefined,
      [existingResult],
    );

    expect(mockedCombined).toHaveBeenCalledTimes(1);
    // generateSessionSuggestions called once for existing result only
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(result.allSuggestions).toHaveLength(2);
    // Existing results are processed first, then new
    expect(result.sessionResults[0].sessionId).toBe('existing-1');
    expect(result.sessionResults[1].sessionId).toBe('new-1');
  });

  it('processes sessions concurrently (analyze phase)', async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => makeSession(`session-${i}`));

    let concurrent = 0;
    let maxConcurrent = 0;

    mockedCombined.mockImplementation(async (session) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return {
        analysisResult: makeAnalysisResult(session.sessionId, []),
        suggestions: [],
      };
    });

    await runPerSessionPipeline(
      sessions,
      '/fake/store',
      '/test/project',
      defaultRulesSnapshot,
      defaultOpts,
    );

    // Analysis should run up to 3 concurrently
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(mockedCombined).toHaveBeenCalledTimes(5);
  });
});
