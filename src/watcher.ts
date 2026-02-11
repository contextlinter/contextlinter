import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectInfo, SessionFileInfo, SessionInfo } from './session-reader/types.js';
import type { AnalysisResult } from './analyzer/types.js';
import type { ModelName } from './analyzer/llm-client.js';
import {
  discoverProjects,
  discoverSessionsInDir,
} from './session-reader/discovery.js';
import { buildSessionInfo } from './session-reader/parser.js';
import { findProjectRoot } from './utils/paths.js';
import { initStoreDir } from './store/persistence.js';
import { cacheSession, getCachedSession } from './store/session-cache.js';
import {
  loadAuditLog,
  markSessionAnalyzed,
  markSessionParsed,
  saveAuditLog,
} from './store/audit.js';
import { saveAnalysisResult } from './store/analysis-store.js';
import { checkCliAvailable, getPromptVersion } from './analyzer/llm-client.js';
import { analyzeSingleSession } from './analyzer/single-session.js';
import { isSessionAnalyzable } from './analyzer/preparer.js';
import { loadSuggestionInputs } from './suggester/loader.js';
import { generateSuggestions, computeSuggestionCacheKey } from './suggester/generator.js';
import { dedupAndRank } from './suggester/dedup.js';
import { saveSuggestionSet, findSuggestionSetByCacheKey } from './store/suggestion-store.js';
import { printError, printVerbose, printWarning } from './utils/logger.js';
import { color } from './ui/theme.js';
import { step, substep, lastSub, success } from './ui/format.js';
import { buildBanner } from './ui/banner.js';

export interface WatchOptions {
  project?: string;
  interval: number;
  cooldown: number;
  model?: string;
  suggest: boolean;
  verbose: boolean;
}

export interface TrackedSession {
  mtime: number;
  size: number;
  analyzed: boolean;
}

export interface WatchStats {
  startedAt: Date;
  sessionsAnalyzed: number;
  insightsFound: number;
  suggestionsGenerated: number;
}

/**
 * Main watch loop. Polls for new/modified Claude Code sessions and analyzes them.
 */
export async function runWatch(opts: WatchOptions): Promise<void> {
  // Check Claude CLI
  const cliAvailable = await checkCliAvailable();
  if (!cliAvailable) {
    printError('Claude Code CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  // Determine project root
  const startDir = opts.project ? resolve(opts.project) : process.cwd();
  const projectRoot = await findProjectRoot(startDir);

  if (!projectRoot) {
    printError(`Could not find project root from ${startDir}. No .git, package.json, or CLAUDE.md found.`);
    process.exit(1);
  }

  // Find the matching Claude project directory
  const projects = await discoverProjects();
  const matchingProject = projects.find((p) => p.projectPath === projectRoot);

  if (!matchingProject) {
    printError(`No Claude sessions found for ${projectRoot}. Use a project with existing Claude Code sessions.`);
    process.exit(1);
  }

  const storeDir = await initStoreDir(projectRoot);

  // Record initial state — mark all existing sessions as "seen"
  const seen = new Map<string, TrackedSession>();
  const audit = await loadAuditLog(storeDir);

  for (const session of matchingProject.sessions) {
    try {
      const fileStat = await stat(session.filePath);
      seen.set(session.sessionId, {
        mtime: fileStat.mtimeMs,
        size: fileStat.size,
        analyzed: audit.sessions[session.sessionId]?.analyzedAt != null,
      });
    } catch {
      // File may have been removed
    }
  }

  const stats: WatchStats = {
    startedAt: new Date(),
    sessionsAnalyzed: 0,
    insightsFound: 0,
    suggestionsGenerated: 0,
  };

  // Print startup banner
  const banner = buildBanner('Watch', projectRoot, {
    Sessions: `${seen.size} existing`,
    Model: opts.model ?? 'sonnet',
  });
  for (const line of banner) console.log(line);
  console.log();

  if (opts.verbose) {
    printVerbose(`Poll interval: ${opts.interval}s, cooldown: ${opts.cooldown}s`);
    printVerbose(`Model: ${opts.model ?? 'sonnet'}, suggest: ${opts.suggest}`);
    printVerbose(`Project dir: ${matchingProject.dirPath}`);
    console.log();
  }

  // Graceful shutdown
  let running = true;
  const shutdown = () => {
    if (!running) return;
    running = false;
    printExitSummary(stats);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Poll loop
  const poll = async () => {
    if (!running) return;

    try {
      await pollOnce(matchingProject, seen, stats, storeDir, projectRoot, opts);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      printWarning(`Poll error: ${msg}`);
    }
  };

  const intervalId = setInterval(poll, opts.interval * 1000);

  // Keep the process alive until shutdown
  await new Promise<void>((resolve) => {
    const check = () => {
      if (!running) {
        clearInterval(intervalId);
        resolve();
      }
    };
    // Check periodically if we should stop
    const checkInterval = setInterval(check, 500);
    process.on('SIGINT', () => {
      clearInterval(checkInterval);
      clearInterval(intervalId);
      resolve();
    });
    process.on('SIGTERM', () => {
      clearInterval(checkInterval);
      clearInterval(intervalId);
      resolve();
    });
  });
}

/**
 * Single poll iteration: discover new/changed sessions and process them.
 */
export async function pollOnce(
  project: ProjectInfo,
  seen: Map<string, TrackedSession>,
  stats: WatchStats,
  storeDir: string,
  projectRoot: string,
  opts: WatchOptions,
): Promise<void> {
  // Re-discover sessions in the project directory
  const currentSessions = await discoverSessionsInDir(project.dirPath);

  // Find new or significantly changed sessions
  const candidates: SessionFileInfo[] = [];

  for (const session of currentSessions) {
    try {
      const fileStat = await stat(session.filePath);
      const existing = seen.get(session.sessionId);

      if (!existing) {
        // New session
        candidates.push(session);
        seen.set(session.sessionId, {
          mtime: fileStat.mtimeMs,
          size: fileStat.size,
          analyzed: false,
        });
      } else if (
        !existing.analyzed &&
        fileStat.size - existing.size > 5120 // >5KB growth
      ) {
        // Existing session grew significantly
        candidates.push(session);
        seen.set(session.sessionId, {
          mtime: fileStat.mtimeMs,
          size: fileStat.size,
          analyzed: false,
        });
      } else {
        // Update tracking info even if we don't analyze
        seen.set(session.sessionId, {
          ...existing,
          mtime: fileStat.mtimeMs,
          size: fileStat.size,
        });
      }
    } catch {
      // File may have been removed between discover and stat
    }
  }

  if (candidates.length === 0) return;

  // Process candidates sequentially
  for (const candidate of candidates) {
    await processCandidate(candidate, project, seen, stats, storeDir, projectRoot, opts);
  }
}

/**
 * Wait for a session file to stop growing, then analyze it.
 */
export async function processCandidate(
  session: SessionFileInfo,
  project: ProjectInfo,
  seen: Map<string, TrackedSession>,
  stats: WatchStats,
  storeDir: string,
  projectRoot: string,
  opts: WatchOptions,
): Promise<void> {
  // Wait for file to stop changing (cooldown period)
  const stable = await waitForStable(session.filePath, opts.cooldown, opts.verbose);
  if (!stable) return;

  // Check audit — don't re-analyze already analyzed sessions
  let audit = await loadAuditLog(storeDir);
  if (audit.sessions[session.sessionId]?.analyzedAt != null) {
    seen.set(session.sessionId, {
      ...seen.get(session.sessionId)!,
      analyzed: true,
    });
    return;
  }

  // Parse the session
  let sessionInfo: SessionInfo;
  try {
    const cached = await getCachedSession(storeDir, session.sessionId, session.filePath);
    if (cached) {
      sessionInfo = cached;
    } else {
      sessionInfo = await buildSessionInfo(session, project.projectPath, project.projectPathEncoded);
      await cacheSession(storeDir, sessionInfo);
      const fileStat = await stat(session.filePath);
      audit = markSessionParsed(audit, session.sessionId, fileStat.mtimeMs);
      await saveAuditLog(storeDir, audit);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.verbose) {
      printWarning(`Failed to parse session ${session.sessionId}: ${msg}`);
    }
    return;
  }

  // Check analyzability
  if (!isSessionAnalyzable(sessionInfo, 2)) {
    // Too short — silently skip
    if (opts.verbose) {
      printVerbose(`Skipping ${session.sessionId.slice(0, 8)}: too short (${sessionInfo.userMessageCount} user messages)`);
    }
    return;
  }

  // Skip contextlinter's own sessions (check for contextlinter commands in user messages)
  if (isContextlinterSession(sessionInfo)) {
    if (opts.verbose) {
      printVerbose(`Skipping ${session.sessionId.slice(0, 8)}: contextlinter internal session`);
    }
    return;
  }

  // Analyze
  const shortId = session.sessionId.slice(0, 8);
  console.log(step(`Session ${shortId} (${sessionInfo.messageCount} messages)`));
  console.log(substep('Analyzing...'));

  let result: AnalysisResult;
  try {
    result = await analyzeSingleSession(sessionInfo, opts.verbose, opts.model as ModelName | undefined);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    printWarning(`Analysis failed for ${shortId}: ${msg}`);
    return;
  }

  // Save result and update audit
  await saveAnalysisResult(storeDir, result);
  const promptVersion = await getPromptVersion('session-analysis');
  audit = await loadAuditLog(storeDir); // Re-load in case it changed
  audit = markSessionAnalyzed(audit, session.sessionId, promptVersion, result.insights.length);
  await saveAuditLog(storeDir, audit);

  seen.set(session.sessionId, {
    ...seen.get(session.sessionId)!,
    analyzed: true,
  });

  stats.sessionsAnalyzed++;
  stats.insightsFound += result.insights.length;

  console.log(success(`${result.insights.length} insight${result.insights.length === 1 ? '' : 's'} found`, false));

  // Optionally generate suggestions scoped to this session's insights
  if (opts.suggest && result.insights.length > 0) {
    const suggestionsGenerated = await runScopedSuggest(
      storeDir,
      projectRoot,
      result.insights.map((i) => i.id),
      opts,
    );
    stats.suggestionsGenerated += suggestionsGenerated;

    if (suggestionsGenerated > 0) {
      console.log(success(`${suggestionsGenerated} suggestion${suggestionsGenerated === 1 ? '' : 's'} generated`));
    }
  }

  console.log(lastSub(`Run ${color.bold('contextlinter apply')} to review.`));
  console.log();
}

/**
 * Wait for a file to stop changing (no mtime change for `cooldownSec` seconds).
 */
export async function waitForStable(filePath: string, cooldownSec: number, verbose: boolean): Promise<boolean> {
  if (verbose) {
    printVerbose(`Waiting ${cooldownSec}s for ${filePath} to stabilize...`);
  }

  let lastMtime: number;
  try {
    const s = await stat(filePath);
    lastMtime = s.mtimeMs;
  } catch {
    return false;
  }

  // Wait for cooldown period, then check if mtime changed
  await delay(cooldownSec * 1000);

  try {
    const s = await stat(filePath);
    if (s.mtimeMs !== lastMtime) {
      // File is still being written to — wait one more cooldown cycle
      if (verbose) {
        printVerbose('File still changing, waiting another cycle...');
      }
      await delay(cooldownSec * 1000);

      const s2 = await stat(filePath);
      if (s2.mtimeMs !== s.mtimeMs) {
        // Still changing — skip this round, we'll catch it next poll
        if (verbose) {
          printVerbose('File still changing after second wait, deferring to next poll.');
        }
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Run suggestion generation scoped to specific insight IDs.
 * Returns the number of suggestions generated.
 */
export async function runScopedSuggest(
  storeDir: string,
  projectRoot: string,
  insightIds: string[],
  opts: WatchOptions,
): Promise<number> {
  try {
    let { insights, crossPatterns, rulesSnapshot } = await loadSuggestionInputs(storeDir, projectRoot);

    // Scope to the provided insight IDs
    const scopedSet = new Set(insightIds);
    insights = insights.filter((i) => scopedSet.has(i.id));
    crossPatterns = crossPatterns.filter((p) => scopedSet.has(p.id));

    if (insights.length === 0 && crossPatterns.length === 0) return 0;

    // Check suggestion cache
    const promptVersion = await getPromptVersion('suggestion-generation');
    const cacheKey = computeSuggestionCacheKey(
      insights.map((i) => i.id),
      crossPatterns.map((p) => p.id),
      rulesSnapshot,
      promptVersion,
    );

    const cachedSet = await findSuggestionSetByCacheKey(storeDir, cacheKey);
    if (cachedSet) return cachedSet.suggestions.length;

    // Generate suggestions
    const result = await generateSuggestions(
      insights,
      crossPatterns,
      rulesSnapshot,
      opts.verbose,
      opts.model as ModelName | undefined,
    );

    const ranked = dedupAndRank(result.suggestions);
    if (ranked.length === 0) return 0;

    // Build and save suggestion set
    const stats = {
      total: ranked.length,
      byType: {
        add: ranked.filter((s) => s.type === 'add').length,
        update: ranked.filter((s) => s.type === 'update').length,
        remove: ranked.filter((s) => s.type === 'remove').length,
        consolidate: ranked.filter((s) => s.type === 'consolidate').length,
        split: ranked.filter((s) => s.type === 'split').length,
      },
      byPriority: {
        high: ranked.filter((s) => s.priority === 'high').length,
        medium: ranked.filter((s) => s.priority === 'medium').length,
        low: ranked.filter((s) => s.priority === 'low').length,
      },
      insightsUsed: insights.length + crossPatterns.length - result.skipped.length,
      insightsSkipped: result.skipped.length,
      estimatedRulesAfter: rulesSnapshot.stats.totalRules + ranked.filter((s) => s.type === 'add').length,
    };

    await saveSuggestionSet(storeDir, {
      projectPath: projectRoot,
      generatedAt: new Date().toISOString(),
      suggestions: ranked,
      stats,
      cacheKey,
    });

    return ranked.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.verbose) {
      printWarning(`Suggestion generation failed: ${msg}`);
    }
    return 0;
  }
}

/**
 * Check if a session is a contextlinter internal session.
 * Detects sessions where the user was running contextlinter commands.
 */
export function isContextlinterSession(session: SessionInfo): boolean {
  const firstMessages = session.messages.slice(0, 5);
  for (const msg of firstMessages) {
    if (msg.role === 'user') {
      const text = msg.textContent.toLowerCase();
      if (text.includes('contextlinter') && (
        text.includes('analyze') ||
        text.includes('suggest') ||
        text.includes('apply') ||
        text.includes('watch') ||
        text.includes('run')
      )) {
        return true;
      }
    }
    // Check for contextlinter tool usage in assistant messages
    if (msg.role === 'assistant') {
      for (const tool of msg.toolUses) {
        if (tool.name === 'Bash') {
          const input = tool.input as Record<string, unknown> | null;
          if (input && typeof input.command === 'string' && input.command.includes('contextlinter')) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

export function printExitSummary(stats: WatchStats): void {
  const duration = Date.now() - stats.startedAt.getTime();
  const hours = Math.floor(duration / 3600000);
  const minutes = Math.floor((duration % 3600000) / 60000);
  const durationStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  console.log();
  console.log(step('Watch Summary'));
  console.log(substep(`Duration: ${durationStr}`));
  console.log(substep(`Sessions analyzed: ${stats.sessionsAnalyzed}`));
  console.log(substep(`Insights found: ${stats.insightsFound}`));

  if (stats.suggestionsGenerated > 0) {
    console.log(substep(`Suggestions generated: ${stats.suggestionsGenerated}`));
    console.log(lastSub(`Run ${color.bold('contextlinter apply')} to review pending suggestions.`));
  } else {
    console.log(lastSub(`Suggestions generated: ${stats.suggestionsGenerated}`));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
