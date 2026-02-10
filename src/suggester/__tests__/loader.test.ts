import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisResult, CrossSessionPattern, Insight } from '../../analyzer/types.js';

// ---------------------------------------------------------------------------
// Mocks — isolate loader from rules-reader and rules-cache
// ---------------------------------------------------------------------------

vi.mock('../../rules-reader/discovery.js', () => ({
  discoverRulesFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../rules-reader/snapshot.js', () => ({
  buildRulesSnapshot: vi.fn().mockResolvedValue({
    projectRoot: '/fake/project',
    snapshotAt: '2025-01-15T12:00:00Z',
    files: [],
    allRules: [],
    stats: {
      totalFiles: 0,
      totalRules: 0,
      byScope: { global: 0, project: 0, project_local: 0, subdirectory: 0 },
      byFormat: { heading_section: 0, bullet_point: 0, paragraph: 0, command: 0, emphatic: 0 },
      totalLines: 0,
      totalSizeBytes: 0,
      hasGlobalRules: false,
      hasLocalRules: false,
      hasModularRules: false,
      importCount: 0,
    },
  }),
}));

vi.mock('../../store/rules-cache.js', () => ({
  getCachedRulesSnapshot: vi.fn().mockResolvedValue(null),
  cacheRulesSnapshot: vi.fn().mockResolvedValue(undefined),
}));

import { loadSuggestionInputs } from '../loader.js';
import { saveCrossSessionPatterns } from '../../store/analysis-store.js';
import { getCachedRulesSnapshot } from '../../store/rules-cache.js';
import { discoverRulesFiles } from '../../rules-reader/discovery.js';

const mockedGetCachedRulesSnapshot = vi.mocked(getCachedRulesSnapshot);
const mockedDiscoverRulesFiles = vi.mocked(discoverRulesFiles);

// ---------------------------------------------------------------------------
// Helpers — build realistic fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let storeDir: string;
let projectRoot: string;
let sessionsDir: string;
let crossDir: string;

function makeInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: 'insight-001',
    category: 'missing_project_knowledge',
    confidence: 0.85,
    title: 'Project uses pnpm not npm',
    description: 'The assistant repeatedly tried npm when the project uses pnpm.',
    evidence: [
      {
        role: 'user',
        text: 'No, use pnpm please',
        timestamp: '2025-01-15T10:05:00Z',
        messageIndex: 3,
      },
    ],
    suggestedRule: '- Use pnpm as the package manager, not npm',
    actionHint: 'add_to_rules',
    sessionId: 'session-abc',
    projectPath: '/home/user/my-project',
    ...overrides,
  };
}

function makeAnalysisResult(insights: Insight[], sessionId = 'session-abc'): AnalysisResult {
  return {
    sessionId,
    projectPath: '/home/user/my-project',
    analyzedAt: '2025-01-15T12:00:00Z',
    insights,
    stats: {
      totalMessages: 42,
      userMessages: 18,
      correctionsDetected: 3,
      insightsGenerated: insights.length,
      analysisTimeMs: 1500,
      tokensUsed: 2000,
    },
  };
}

function makeCrossPattern(overrides: Partial<CrossSessionPattern> = {}): CrossSessionPattern {
  return {
    id: 'pattern-001',
    category: 'repeated_correction',
    confidence: 0.9,
    title: 'Always run tests before committing',
    description: 'User corrected the assistant across multiple sessions to run tests first.',
    occurrences: [
      { sessionId: 'session-abc', insightId: 'insight-001', timestamp: '2025-01-15T10:05:00Z' },
      { sessionId: 'session-def', insightId: 'insight-002', timestamp: '2025-01-16T14:30:00Z' },
    ],
    suggestedRule: '- Always run the test suite before creating a commit',
    actionHint: 'add_to_rules',
    projectPath: '/home/user/my-project',
    ...overrides,
  };
}

async function writeSessionFile(filename: string, result: AnalysisResult): Promise<void> {
  await writeFile(join(sessionsDir, filename), JSON.stringify(result, null, 2), 'utf-8');
}

async function writeCrossFile(filename: string, patterns: CrossSessionPattern[]): Promise<void> {
  await writeFile(join(crossDir, filename), JSON.stringify(patterns, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'loader-test-'));
  storeDir = join(tempDir, '.contextlinter');
  projectRoot = join(tempDir, 'project');
  sessionsDir = join(storeDir, 'analysis', 'sessions');
  crossDir = join(storeDir, 'analysis', 'cross-session');

  await mkdir(sessionsDir, { recursive: true });
  await mkdir(crossDir, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Loading session insights
// ---------------------------------------------------------------------------

describe('loading session insights', () => {
  it('loads insights from .contextlinter/analysis/sessions/*.json', async () => {
    const insight1 = makeInsight({ id: 'ins-1', title: 'Use pnpm' });
    const insight2 = makeInsight({ id: 'ins-2', title: 'Prefer vitest' });

    await writeSessionFile('session-abc.json', makeAnalysisResult([insight1], 'session-abc'));
    await writeSessionFile('session-def.json', makeAnalysisResult([insight2], 'session-def'));

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(2);
    const ids = result.insights.map((i) => i.id);
    expect(ids).toContain('ins-1');
    expect(ids).toContain('ins-2');
  });

  it('collects multiple insights from a single session file', async () => {
    const insights = [
      makeInsight({ id: 'ins-a', confidence: 0.9 }),
      makeInsight({ id: 'ins-b', confidence: 0.8 }),
      makeInsight({ id: 'ins-c', confidence: 0.7 }),
    ];

    await writeSessionFile('session-multi.json', makeAnalysisResult(insights));

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(3);
  });

  it('skips non-JSON files in the sessions directory', async () => {
    await writeSessionFile('session-abc.json', makeAnalysisResult([makeInsight()]));
    await writeFile(join(sessionsDir, 'README.md'), '# Not a session', 'utf-8');
    await writeFile(join(sessionsDir, '.gitkeep'), '', 'utf-8');

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Loading cross-session patterns
// ---------------------------------------------------------------------------

describe('loading cross-session patterns', () => {
  it('loads patterns from .contextlinter/analysis/cross-session/*.json', async () => {
    const patterns = [
      makeCrossPattern({ id: 'pat-1' }),
      makeCrossPattern({ id: 'pat-2' }),
    ];

    await writeCrossFile('2025-01-15T12-00-00Z.json', patterns);

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.crossPatterns).toHaveLength(2);
    const ids = result.crossPatterns.map((p) => p.id);
    expect(ids).toContain('pat-1');
    expect(ids).toContain('pat-2');
  });

  it('loads only the latest (last sorted) cross-session file', async () => {
    const oldPatterns = [makeCrossPattern({ id: 'old-pat', title: 'Old pattern' })];
    const newPatterns = [makeCrossPattern({ id: 'new-pat', title: 'New pattern' })];

    await writeCrossFile('2025-01-10T08-00-00Z.json', oldPatterns);
    await writeCrossFile('2025-01-15T12-00-00Z.json', newPatterns);

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.crossPatterns).toHaveLength(1);
    expect(result.crossPatterns[0].id).toBe('new-pat');
  });
});

// ---------------------------------------------------------------------------
// Correct path usage (the bug that was fixed)
// ---------------------------------------------------------------------------

describe('correct path usage', () => {
  it('uses storeDir for analysis paths, not CWD', async () => {
    // Write a session file into our storeDir (the correct location)
    await writeSessionFile(
      'session-xyz.json',
      makeAnalysisResult([makeInsight({ id: 'correct-path' })]),
    );

    // The loader should find it via storeDir, NOT via process.cwd()
    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].id).toBe('correct-path');
  });

  it('does not accidentally read from a different directory', async () => {
    // Create a decoy analysis dir at a different location
    const decoyDir = join(tempDir, 'decoy');
    const decoySessionsDir = join(decoyDir, 'analysis', 'sessions');
    await mkdir(decoySessionsDir, { recursive: true });
    await writeFile(
      join(decoySessionsDir, 'session-decoy.json'),
      JSON.stringify(makeAnalysisResult([makeInsight({ id: 'decoy-insight' })])),
      'utf-8',
    );

    // Point the loader at the real (empty) storeDir — should find nothing
    // (sessions dir exists but is empty)
    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(0);
    expect(result.insights.map((i) => i.id)).not.toContain('decoy-insight');
  });
});

// ---------------------------------------------------------------------------
// Confidence filtering
// ---------------------------------------------------------------------------

describe('confidence filtering', () => {
  it('filters out insights below confidence threshold (0.5)', async () => {
    const insights = [
      makeInsight({ id: 'high', confidence: 0.85 }),
      makeInsight({ id: 'borderline', confidence: 0.5 }),
      makeInsight({ id: 'low', confidence: 0.49 }),
      makeInsight({ id: 'very-low', confidence: 0.1 }),
    ];

    await writeSessionFile('session.json', makeAnalysisResult(insights));

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    const ids = result.insights.map((i) => i.id);
    expect(ids).toContain('high');
    expect(ids).toContain('borderline');
    expect(ids).not.toContain('low');
    expect(ids).not.toContain('very-low');
  });

  it('filters out cross-session patterns below confidence threshold', async () => {
    const patterns = [
      makeCrossPattern({ id: 'strong', confidence: 0.75 }),
      makeCrossPattern({ id: 'weak', confidence: 0.3 }),
    ];

    await writeCrossFile('2025-01-15T12-00-00Z.json', patterns);

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.crossPatterns).toHaveLength(1);
    expect(result.crossPatterns[0].id).toBe('strong');
  });

  it('counts total filtered-out items from both insights and patterns', async () => {
    const insights = [
      makeInsight({ id: 'keep', confidence: 0.9 }),
      makeInsight({ id: 'drop-1', confidence: 0.2 }),
      makeInsight({ id: 'drop-2', confidence: 0.4 }),
    ];
    const patterns = [
      makeCrossPattern({ id: 'keep-pat', confidence: 0.8 }),
      makeCrossPattern({ id: 'drop-pat', confidence: 0.1 }),
    ];

    await writeSessionFile('session.json', makeAnalysisResult(insights));
    await writeCrossFile('2025-01-15T12-00-00Z.json', patterns);

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    // 2 low insights + 1 low pattern = 3 filtered out
    expect(result.filteredOut).toBe(3);
  });

  it('returns filteredOut = 0 when all items pass the threshold', async () => {
    const insights = [
      makeInsight({ id: 'a', confidence: 0.6 }),
      makeInsight({ id: 'b', confidence: 0.9 }),
    ];

    await writeSessionFile('session.json', makeAnalysisResult(insights));

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.filteredOut).toBe(0);
    expect(result.insights).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Missing directories — graceful degradation
// ---------------------------------------------------------------------------

describe('missing directories', () => {
  it('returns empty insights when sessions directory does not exist', async () => {
    // Use a storeDir that has no analysis/ subdirectory at all
    const emptyStore = join(tempDir, 'empty-store');
    await mkdir(emptyStore, { recursive: true });

    const result = await loadSuggestionInputs(emptyStore, projectRoot);

    expect(result.insights).toHaveLength(0);
    expect(result.crossPatterns).toHaveLength(0);
  });

  it('returns empty insights when storeDir itself does not exist', async () => {
    const nonexistent = join(tempDir, 'does-not-exist');

    const result = await loadSuggestionInputs(nonexistent, projectRoot);

    expect(result.insights).toHaveLength(0);
    expect(result.crossPatterns).toHaveLength(0);
    expect(result.filteredOut).toBe(0);
  });

  it('returns empty cross-patterns when cross-session directory is empty', async () => {
    // sessions dir has data, but cross-session dir is empty
    await writeSessionFile('session.json', makeAnalysisResult([makeInsight()]));

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(1);
    expect(result.crossPatterns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON — graceful degradation
// ---------------------------------------------------------------------------

describe('malformed JSON files', () => {
  it('skips session files with invalid JSON without crashing', async () => {
    // One good file, one broken file
    await writeSessionFile('good.json', makeAnalysisResult([makeInsight({ id: 'good' })]));
    await writeFile(join(sessionsDir, 'bad.json'), '{ not valid json !!!', 'utf-8');

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].id).toBe('good');
  });

  it('returns empty cross-patterns when the latest file is malformed', async () => {
    await writeFile(join(crossDir, '2025-01-15T12-00-00Z.json'), 'BROKEN', 'utf-8');

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.crossPatterns).toHaveLength(0);
  });

  it('handles session files with missing insights field', async () => {
    // Valid JSON but not the expected shape (no insights array)
    await writeFile(
      join(sessionsDir, 'no-insights.json'),
      JSON.stringify({ sessionId: 'orphan', analyzedAt: '2025-01-15T12:00:00Z' }),
      'utf-8',
    );

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(0);
  });

  it('handles empty JSON array as cross-session file', async () => {
    await writeCrossFile('2025-01-15T12-00-00Z.json', []);

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.crossPatterns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stats / counts
// ---------------------------------------------------------------------------

describe('returned stats', () => {
  it('counts insights correctly across multiple session files', async () => {
    await writeSessionFile(
      's1.json',
      makeAnalysisResult([
        makeInsight({ id: 'a1', confidence: 0.9 }),
        makeInsight({ id: 'a2', confidence: 0.7 }),
      ], 'session-1'),
    );
    await writeSessionFile(
      's2.json',
      makeAnalysisResult([
        makeInsight({ id: 'b1', confidence: 0.6 }),
      ], 'session-2'),
    );

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(3);
    expect(result.filteredOut).toBe(0);
  });

  it('returns a valid rulesSnapshot', async () => {
    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.rulesSnapshot).toBeDefined();
    expect(result.rulesSnapshot.files).toBeInstanceOf(Array);
    expect(result.rulesSnapshot.allRules).toBeInstanceOf(Array);
  });

  it('returns cached rulesSnapshot when cache hits', async () => {
    const cachedSnapshot = {
      projectRoot: '/cached/project',
      snapshotAt: '2025-01-14T10:00:00Z',
      files: [],
      allRules: [],
      stats: {
        totalFiles: 1,
        totalRules: 5,
        byScope: { global: 0, project: 5, project_local: 0, subdirectory: 0 },
        byFormat: { heading_section: 0, bullet_point: 5, paragraph: 0, command: 0, emphatic: 0 },
        totalLines: 10,
        totalSizeBytes: 200,
        hasGlobalRules: false,
        hasLocalRules: false,
        hasModularRules: false,
        importCount: 0,
      },
    };

    mockedDiscoverRulesFiles.mockResolvedValueOnce([
      { path: '/project/CLAUDE.md', relativePath: 'CLAUDE.md', scope: 'project', lastModified: 1700000000000, sizeBytes: 512 },
    ]);
    mockedGetCachedRulesSnapshot.mockResolvedValueOnce(cachedSnapshot);

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.rulesSnapshot).toBe(cachedSnapshot);
    expect(result.rulesSnapshot.stats.totalRules).toBe(5);
  });

  it('filteredOut reflects exactly how many items were removed', async () => {
    // 5 insights: 3 above threshold, 2 below
    const insights = [
      makeInsight({ id: 'i1', confidence: 0.9 }),
      makeInsight({ id: 'i2', confidence: 0.7 }),
      makeInsight({ id: 'i3', confidence: 0.5 }),
      makeInsight({ id: 'i4', confidence: 0.49 }),
      makeInsight({ id: 'i5', confidence: 0.0 }),
    ];

    await writeSessionFile('session.json', makeAnalysisResult(insights));

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.insights).toHaveLength(3);
    expect(result.filteredOut).toBe(2);
    // Verify the exact surviving insights
    expect(result.insights.map((i) => i.id).sort()).toEqual(['i1', 'i2', 'i3']);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: saveCrossSessionPatterns → loadSuggestionInputs
// ---------------------------------------------------------------------------

describe('cross-session save/load round-trip', () => {
  it('patterns saved via saveCrossSessionPatterns are loadable via loadSuggestionInputs', async () => {
    const patterns = [
      makeCrossPattern({ id: 'rt-1', title: 'Run tests first', confidence: 0.9 }),
      makeCrossPattern({ id: 'rt-2', title: 'Use pnpm', confidence: 0.8 }),
      makeCrossPattern({ id: 'rt-3', title: 'Prefer vitest', confidence: 0.7 }),
    ];

    // Save using the actual store function (same one used by runAnalyze)
    await saveCrossSessionPatterns(storeDir, patterns);

    // Load using the actual loader function (same one used by runSuggest)
    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.crossPatterns).toHaveLength(3);
    const ids = result.crossPatterns.map((p) => p.id);
    expect(ids).toContain('rt-1');
    expect(ids).toContain('rt-2');
    expect(ids).toContain('rt-3');
  });

  it('preserves all pattern fields through save/load', async () => {
    const pattern = makeCrossPattern({
      id: 'full-rt',
      title: 'Always run tests',
      description: 'User corrected multiple times',
      confidence: 0.95,
      category: 'repeated_correction',
      suggestedRule: '- Always run tests before committing',
      actionHint: 'add_to_rules',
    });

    await saveCrossSessionPatterns(storeDir, [pattern]);
    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.crossPatterns).toHaveLength(1);
    const loaded = result.crossPatterns[0];
    expect(loaded.id).toBe('full-rt');
    expect(loaded.title).toBe('Always run tests');
    expect(loaded.description).toBe('User corrected multiple times');
    expect(loaded.confidence).toBe(0.95);
    expect(loaded.category).toBe('repeated_correction');
    expect(loaded.suggestedRule).toBe('- Always run tests before committing');
    expect(loaded.actionHint).toBe('add_to_rules');
    expect(loaded.occurrences).toHaveLength(2);
  });

  it('latest save wins when multiple saves occur', async () => {
    const oldPatterns = [makeCrossPattern({ id: 'old', title: 'Old' })];
    const newPatterns = [makeCrossPattern({ id: 'new', title: 'New' })];

    await saveCrossSessionPatterns(storeDir, oldPatterns);
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    await saveCrossSessionPatterns(storeDir, newPatterns);

    const result = await loadSuggestionInputs(storeDir, projectRoot);

    expect(result.crossPatterns).toHaveLength(1);
    expect(result.crossPatterns[0].id).toBe('new');
  });
});
