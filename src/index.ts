#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { CLIOptions, ProjectInfo, SessionInfo } from './session-reader/types.js';
import type { AnalyzeOptions, AnalysisResult } from './analyzer/types.js';
import type { SuggestOptions } from './suggester/types.js';
import type { ApplyOptions } from './applier/types.js';
import {
  discoverProjects,
  filterByDays,
  filterByProject,
  findSessionById,
  limitSessions,
} from './session-reader/discovery.js';
import { buildSessionInfo } from './session-reader/parser.js';
import { buildRulesSnapshot } from './rules-reader/snapshot.js';
import { discoverRulesFiles } from './rules-reader/discovery.js';
import { findProjectRoot, isWindowsPlatform } from './utils/paths.js';
import {
  printAnalysisDone,
  printAnalysisSummaryLine,
  printAnalysisProgress,
  printAnalyzerHeader,
  printDryRun,
  printError,
  printHeader,
  printInsightResults,
  printNothingToAnalyze,
  printProjectHeader,
  printRulesDetailed,
  printRulesHeader,
  printRulesOverview,
  printSessionDetail,
  printSessionsDebugList,
  printSkippedSummary,
  printSessionsTable,
  printSuggesterHeader,
  printSuggestionGenerating,
  printSuggestionGenerated,
  printSuggestionLoadingSummary,
  printSuggestionResults,
  printSummary,
  printVerbose,
  printWarning,
} from './utils/logger.js';
import { initStoreDir } from './store/persistence.js';
import { cacheSession, getCachedSession } from './store/session-cache.js';
import { cacheRulesSnapshot, getCachedRulesSnapshot } from './store/rules-cache.js';
import {
  loadAuditLog,
  markCrossSessionDone,
  markSessionAnalyzed,
  markSessionParsed,
  needsAnalysis,
  saveAuditLog,
} from './store/audit.js';
import { saveAnalysisResult, saveCrossSessionPatterns } from './store/analysis-store.js';
import { checkCliAvailable, getPromptVersion, type ModelName } from './analyzer/llm-client.js';
import { analyzeSingleSession } from './analyzer/single-session.js';
import { synthesizeCrossSessions } from './analyzer/cross-session.js';
import { isSessionAnalyzable } from './analyzer/preparer.js';
import { loadSuggestionInputs } from './suggester/loader.js';
import { generateSuggestions, computeSuggestionCacheKey } from './suggester/generator.js';
import { dedupAndRank } from './suggester/dedup.js';
import { saveSuggestionSet, loadLatestSuggestionSet, findSuggestionSetByCacheKey } from './store/suggestion-store.js';
import { runInteractiveReview } from './applier/interactive.js';
import { runWatch, type WatchOptions } from './watcher.js';
import { brand, color } from './ui/theme.js';
import { step, substep, success, secondary, tertiary, treeCont, lastSub, shortPath } from './ui/format.js';
import { buildBanner } from './ui/banner.js';


interface RulesOptions {
  project: string | undefined;
  list: boolean;
  verbose: boolean;
}

interface ParsedCLI {
  command: 'run' | 'list' | 'analyze' | 'session-detail' | 'rules' | 'suggest' | 'apply' | 'init' | 'watch';
  options: CLIOptions;
  analyzeOptions: AnalyzeOptions;
  rulesOptions: RulesOptions;
  suggestOptions: SuggestOptions;
  applyOptions: ApplyOptions;
  watchOptions: WatchOptions;
}

function printHelp(): void {
  console.log(`
${brand.emerald('contextlinter')} <command> [options]

${color.bold('Commands:')}
  run        Full pipeline: analyze → suggest → apply
  analyze    Analyze Claude Code sessions for insights
  suggest    Generate rule suggestions from insights
  apply      Review and apply suggestions interactively
  watch      Monitor for new sessions and auto-analyze
  rules      Show current rules overview
  init       Create slash command file

${color.bold('Options:')}
  --limit N          Analyze only N newest sessions
  --min-messages N   Minimum user messages to analyze (default: 2)
  --model <model>    LLM model: sonnet (default), opus, haiku
  --project <path>   Target specific project
  --all              Analyze all projects (default: CWD only)
  --yes              Auto-confirm (skip prompts)
  --dry-run          Preview without applying
  --verbose          Show detailed output
  --help             Show this help

${color.bold('Watch options:')}
  --interval N       Poll interval in seconds (default: 300)
  --cooldown N       Wait before analyzing new session (default: 60)
  --no-suggest       Only analyze, don't generate suggestions

${color.bold('Apply options:')}
  --min-confidence N Only apply above confidence threshold
`.trimEnd());
}

function parseCLIArgs(): ParsedCLI {
  const { values, positionals } = parseArgs({
    options: {
      project: { type: 'string' },
      all: { type: 'boolean', default: false },
      session: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      limit: { type: 'string' },
      days: { type: 'string' },
      force: { type: 'boolean', default: false },
      'no-cross': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'min-confidence': { type: 'string' },
      'min-messages': { type: 'string' },
      model: { type: 'string' },
      interval: { type: 'string' },
      cooldown: { type: 'string' },
      'no-suggest': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help || (!positionals.length && !values.session)) {
    printHelp();
    process.exit(0);
  }

  const cmd = positionals[0];
  const command = cmd === 'run' ? 'run'
    : cmd === 'analyze' ? 'analyze'
    : cmd === 'rules' ? 'rules'
    : cmd === 'suggest' ? 'suggest'
    : cmd === 'apply' ? 'apply'
    : cmd === 'watch' ? 'watch'
    : cmd === 'init' ? 'init'
    : values.session ? 'session-detail'
    : 'list';

  return {
    command,
    options: {
      project: values.project as string | undefined,
      all: Boolean(values.all),
      session: values.session as string | undefined,
      verbose: Boolean(values.verbose),
      limit: values.limit ? parseInt(values.limit as string, 10) : undefined,
      days: values.days ? parseInt(values.days as string, 10) : undefined,
    },
    analyzeOptions: {
      project: values.project as string | undefined,
      all: Boolean(values.all),
      limit: values.limit ? parseInt(values.limit as string, 10) : undefined,
      force: Boolean(values.force),
      verbose: Boolean(values.verbose),
      noCross: Boolean(values['no-cross']),
      dryRun: Boolean(values['dry-run']),
      yes: Boolean(values.yes),
      model: values.model as string | undefined,
      minMessages: values['min-messages'] ? parseInt(values['min-messages'] as string, 10) : undefined,
    },
    rulesOptions: {
      project: values.project as string | undefined,
      list: Boolean(values.list),
      verbose: Boolean(values.verbose),
    },
    suggestOptions: {
      project: values.project as string | undefined,
      all: Boolean(values.all),
      verbose: Boolean(values.verbose),
      full: Boolean(values.full),
      limit: values.limit ? parseInt(values.limit as string, 10) : undefined,
      model: values.model as string | undefined,
    },
    applyOptions: {
      project: values.project as string | undefined,
      all: Boolean(values.all),
      verbose: Boolean(values.verbose),
      yes: Boolean(values.yes),
      dryRun: Boolean(values['dry-run']),
      minConfidence: values['min-confidence']
        ? parseFloat(values['min-confidence'] as string)
        : undefined,
      limit: values.limit ? parseInt(values.limit as string, 10) : undefined,
      full: Boolean(values.full),
      model: values.model as string | undefined,
    },
    watchOptions: {
      project: values.project as string | undefined,
      interval: values.interval ? parseInt(values.interval as string, 10) : 300,
      cooldown: values.cooldown ? parseInt(values.cooldown as string, 10) : 60,
      model: values.model as string | undefined,
      suggest: !Boolean(values['no-suggest']),
      verbose: Boolean(values.verbose),
    },
  };
}

async function main(): Promise<void> {
  if (isWindowsPlatform()) {
    printError('Windows is not supported yet. macOS and Linux only.');
    process.exit(1);
  }

  const cli = parseCLIArgs();

  // Commands that don't need Claude projects discovery
  if (cli.command === 'rules') {
    await runRules(cli.rulesOptions);
    return;
  }

  if (cli.command === 'suggest') {
    await runSuggest(cli.suggestOptions);
    return;
  }

  if (cli.command === 'apply') {
    await runApply(cli.applyOptions);
    return;
  }

  if (cli.command === 'init') {
    await runInit(cli.applyOptions);
    return;
  }

  if (cli.command === 'watch') {
    await runWatch(cli.watchOptions);
    return;
  }

  let projects = await discoverProjects();
  if (projects.length === 0) {
    printError(
      'No Claude Code projects found. Is Claude Code installed? Expected directory: ~/.claude/projects/',
    );
    process.exit(1);
  }

  // CWD-based project filtering (default behavior)
  if (!cli.options.project && !cli.options.all) {
    const cwd = process.cwd();
    const projectRoot = await findProjectRoot(cwd);
    const matchPath = projectRoot ?? cwd;
    projects = projects.filter((p) => p.projectPath === matchPath);
    if (projects.length === 0) {
      printError(
        `No Claude sessions found for ${matchPath}. Use --all to scan all projects.`,
      );
      process.exit(1);
    }
  }

  if (cli.command === 'run') {
    await runRun(projects, cli.analyzeOptions, cli.suggestOptions, cli.applyOptions);
  } else if (cli.command === 'analyze') {
    await runAnalyze(projects, cli.analyzeOptions);
  } else if (cli.command === 'session-detail') {
    await runSessionDetail(projects, cli.options);
  } else {
    await runList(projects, cli.options);
  }
}

// === Rules command ===

async function runRules(opts: RulesOptions): Promise<void> {
  // Determine project root
  const startDir = opts.project ? resolve(opts.project) : process.cwd();
  const projectRoot = await findProjectRoot(startDir);

  if (!projectRoot) {
    printError(`Could not find project root from ${startDir}. No .git, package.json, or CLAUDE.md found.`);
    process.exit(1);
  }

  printRulesHeader(projectRoot);

  if (opts.verbose) {
    printVerbose(`Project root: ${projectRoot}`);
  }

  // Check cache
  const storeDir = await initStoreDir(projectRoot);
  const discovered = await discoverRulesFiles(projectRoot);

  const currentMtimes: Record<string, number> = {};
  for (const file of discovered) {
    currentMtimes[file.path] = file.lastModified;
  }

  const cached = await getCachedRulesSnapshot(storeDir, currentMtimes);
  if (cached && !opts.verbose) {
    if (opts.list) {
      printRulesOverview(cached);
      printRulesDetailed(cached);
    } else {
      printRulesOverview(cached);
    }
    return;
  }

  if (cached && opts.verbose) {
    printVerbose('Cache valid but verbose mode — re-parsing for fresh data');
  }

  // Build snapshot
  const snapshot = await buildRulesSnapshot(projectRoot);

  // Cache it
  await cacheRulesSnapshot(storeDir, snapshot);

  // Warn about large files
  for (const file of snapshot.files) {
    const lineCount = file.content.split('\n').length;
    if (lineCount > 500) {
      printWarning(`${file.relativePath} is large (${lineCount} lines) — consider splitting it`);
    }
  }

  // Print output
  printRulesOverview(snapshot);

  if (opts.list) {
    printRulesDetailed(snapshot);
  }
}

// === Suggest command ===

async function runSuggest(opts: SuggestOptions): Promise<void> {
  // Determine project root
  const startDir = opts.project ? resolve(opts.project) : process.cwd();
  const projectRoot = await findProjectRoot(startDir);

  if (!projectRoot) {
    printError(`Could not find project root from ${startDir}. No .git, package.json, or CLAUDE.md found.`);
    process.exit(1);
  }

  printSuggesterHeader(projectRoot);

  // Check Claude CLI
  const cliAvailable = await checkCliAvailable();
  if (!cliAvailable) {
    printError('Claude Code CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  if (opts.verbose) {
    printVerbose(`Project root: ${projectRoot}`);
  }

  const storeDir = await initStoreDir(projectRoot);

  // --full flag: run analyze first
  if (opts.full) {
    const projects = await discoverProjects();
    let matchingProjects: ProjectInfo[];
    if (opts.project) {
      matchingProjects = filterByProject(projects, opts.project);
    } else if (opts.all) {
      matchingProjects = projects;
    } else {
      // CWD-aware: only analyze current project
      matchingProjects = projects.filter((p) => p.projectPath === projectRoot);
    }

    if (matchingProjects.length > 0) {
      await runAnalyze(matchingProjects, {
        project: opts.project,
        all: opts.all,
        limit: opts.limit,
        verbose: opts.verbose,
        force: false,
        noCross: false,
        dryRun: false,
        yes: true,
        model: opts.model,
      });
    }
  }

  // Load insights + rules
  let { insights, crossPatterns, rulesSnapshot, filteredOut } = await loadSuggestionInputs(storeDir, projectRoot);

  // If called from the run pipeline with scoped IDs, filter to only those
  if (opts.scopedInsightIds) {
    const scopedSet = new Set(opts.scopedInsightIds);
    insights = insights.filter((i) => scopedSet.has(i.id));
    crossPatterns = crossPatterns.filter((p) => scopedSet.has(p.id));
  }

  printSuggestionLoadingSummary(
    insights.length + crossPatterns.length,
    insights.length,
    crossPatterns.length,
    rulesSnapshot.stats.totalRules,
    rulesSnapshot.stats.totalFiles,
    filteredOut,
  );

  if (insights.length === 0 && crossPatterns.length === 0) {
    printWarning('No insights to process. Run "analyze" first.');
    return;
  }

  // Check suggestion cache before calling the LLM
  const promptVersion = await getPromptVersion('suggestion-generation');
  const cacheKey = computeSuggestionCacheKey(
    insights.map((i) => i.id),
    crossPatterns.map((p) => p.id),
    rulesSnapshot,
    promptVersion,
  );

  const cachedSet = await findSuggestionSetByCacheKey(storeDir, cacheKey);
  if (cachedSet) {
    if (opts.verbose) {
      printVerbose(`Suggestion cache hit (key: ${cacheKey}) — skipping LLM calls`);
    }
    printSuggestionGenerated(cachedSet.suggestions.length, cachedSet.stats.insightsSkipped, 0);
    printSuggestionResults(cachedSet, []);
    return;
  }

  // Generate suggestions via LLM
  printSuggestionGenerating();

  const result = await generateSuggestions(insights, crossPatterns, rulesSnapshot, opts.verbose, opts.model as ModelName | undefined);

  // Dedup and rank
  const ranked = dedupAndRank(result.suggestions);

  printSuggestionGenerated(ranked.length, result.skipped.length, result.durationMs / 1000);

  // Build stats
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

  const suggestionSet = {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    suggestions: ranked,
    stats,
    cacheKey,
  };

  // Save to disk
  const savedPath = await saveSuggestionSet(storeDir, suggestionSet);
  if (opts.verbose) {
    printVerbose(`Suggestions saved to ${savedPath}`);
  }

  // Print results
  printSuggestionResults(suggestionSet, result.skipped);
}

function promptConfirmation(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// === Run command (full pipeline) ===

async function runRun(
  projects: ProjectInfo[],
  analyzeOpts: AnalyzeOptions,
  suggestOpts: SuggestOptions,
  applyOpts: ApplyOptions,
): Promise<void> {
  // Determine project root for store checks between steps
  const startDir = suggestOpts.project ? resolve(suggestOpts.project) : process.cwd();
  const projectRoot = await findProjectRoot(startDir);

  if (!projectRoot) {
    printError(`Could not find project root from ${startDir}. No .git, package.json, or CLAUDE.md found.`);
    process.exit(1);
  }

  const bannerLines = buildBanner('Full Pipeline', projectRoot);
  for (const line of bannerLines) console.log(line);
  console.log();

  // Step 1: Analyze
  const analyzeOutput = await runAnalyze(projects, analyzeOpts);

  // Check if there are insights to work with
  const storeDir = await initStoreDir(projectRoot);
  const { insights, crossPatterns } = await loadSuggestionInputs(storeDir, projectRoot);

  if (insights.length === 0 && crossPatterns.length === 0) {
    console.log();
    console.log('No insights found \u2014 nothing to suggest.');
    return;
  }

  // Step 2: Suggest (without --full since we already analyzed)
  // If analyze produced new insights, scope suggest to only those.
  // If nothing new (all already analyzed), process everything from disk.
  const allScopedIds = [...analyzeOutput.insightIds, ...analyzeOutput.crossPatternIds];
  const scopedInsightIds = allScopedIds.length > 0 ? allScopedIds : undefined;
  await runSuggest({ ...suggestOpts, full: false, scopedInsightIds });

  // Check if suggestions were generated
  const suggestionSet = await loadLatestSuggestionSet(storeDir);
  if (!suggestionSet || suggestionSet.suggestions.length === 0) {
    console.log();
    console.log('No suggestions generated \u2014 nothing to apply.');
    return;
  }

  // Step 3: Apply (without --full since we already suggested)
  await runApply({ ...applyOpts, full: false });
}

// === Analyze command ===

interface AnalyzeOutput {
  insightIds: string[];
  crossPatternIds: string[];
}

async function runAnalyze(projects: ProjectInfo[], opts: AnalyzeOptions): Promise<AnalyzeOutput> {
  const analyzeProjectRoot = opts.project
    ? await findProjectRoot(resolve(opts.project))
    : projects[0]?.projectPath;
  printAnalyzerHeader(analyzeProjectRoot ?? undefined);

  // Check Claude CLI
  const cliAvailable = await checkCliAvailable();
  if (!cliAvailable) {
    printError('Claude Code CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  // Filter projects
  if (opts.project) {
    projects = filterByProject(projects, opts.project);
    if (projects.length === 0) {
      printError(`Project not found: ${opts.project}`);
      process.exit(1);
    }
  }

  const promptVersion = await getPromptVersion('session-analysis');

  const allInsightIds: string[] = [];
  const allCrossPatternIds: string[] = [];

  for (const project of projects) {
    if (project.sessions.length === 0) continue;

    // Init store directory per project (use project's actual path)
    const storeDir = await initStoreDir(project.projectPath);
    let audit = await loadAuditLog(storeDir);

    // Verbose: show all sessions before filtering
    if (opts.verbose) {
      printSessionsDebugList(project.sessions, `All sessions for ${shortPath(project.projectPath)}`);
    }

    const minMessages = opts.minMessages ?? 2;

    // Parse all sessions (with cache)
    const parsed: SessionInfo[] = [];
    for (const sessionFile of project.sessions) {
      try {
        const cached = await getCachedSession(storeDir, sessionFile.sessionId, sessionFile.filePath);
        if (cached) {
          parsed.push(cached);
          continue;
        }

        const info = await buildSessionInfo(
          sessionFile,
          project.projectPath,
          project.projectPathEncoded,
        );
        parsed.push(info);

        // Cache and record in audit
        await cacheSession(storeDir, info);
        const fileStat = await stat(sessionFile.filePath);
        audit = markSessionParsed(audit, sessionFile.sessionId, fileStat.mtimeMs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        printWarning(`Failed to parse session ${sessionFile.sessionId}: ${msg}`);
      }
    }

    // Verbose: show parsed sessions with message counts before filtering
    if (opts.verbose) {
      console.log(treeCont(tertiary(`Parsed sessions (${parsed.length}):`)));
      for (const s of parsed) {
        const shortId = s.sessionId.slice(0, 8);
        const date = s.firstTimestamp
          ? new Date(s.firstTimestamp).toISOString().slice(0, 16).replace('T', ' ')
          : '?';
        const msgs = `${s.userMessageCount} user / ${s.assistantMessageCount} asst`;
        console.log(treeCont(tertiary(`  ${shortId} | ${date} | ${msgs} | ${shortPath(s.projectPath)}`)));
      }
    }

    // Filter out short sessions first, then apply --limit
    let skippedCount = 0;
    const analyzable: SessionInfo[] = [];

    for (const session of parsed) {
      if (!isSessionAnalyzable(session, minMessages)) {
        skippedCount++;
        continue;
      }
      analyzable.push(session);
    }

    // Always show skipped summary (verbose already has full session list above)
    if (skippedCount > 0) {
      printSkippedSummary(skippedCount);
    }

    // Apply --limit after filtering: take N newest from analyzable sessions
    const limited = opts.limit ? analyzable.slice(0, opts.limit) : analyzable;
    if (opts.limit && opts.verbose) {
      console.log(treeCont(tertiary(`After --limit ${opts.limit} (from ${analyzable.length} analyzable): ${limited.length} sessions`)));
    }

    // Determine which sessions need analysis
    const toAnalyze: SessionInfo[] = [];
    let alreadyAnalyzed = 0;

    for (const session of limited) {
      const fileStat = await stat(session.filePath);
      const needs = opts.force || needsAnalysis(audit, session.sessionId, promptVersion, fileStat.mtimeMs);

      if (needs) {
        toAnalyze.push(session);
      } else {
        alreadyAnalyzed++;
      }
    }

    if (toAnalyze.length === 0 && alreadyAnalyzed > 0) {
      printNothingToAnalyze();
      continue;
    }

    if (toAnalyze.length === 0) {
      console.log(lastSub(secondary('No analyzable sessions found.')));
      console.log();
      continue;
    }

    printAnalysisSummaryLine(toAnalyze.length, alreadyAnalyzed, project.projectPath);

    // Prompt for confirmation if many sessions and not auto-confirmed
    if (toAnalyze.length > 10 && !opts.yes && !opts.limit) {
      const estimatedSeconds = toAnalyze.reduce((sum, s) => {
        return sum + 10 + Math.min(s.userMessageCount, 300) * 0.12;
      }, 0) + Math.max(0, toAnalyze.length - 1);
      const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
      const crossNote = !opts.noCross && toAnalyze.length >= 2
        ? ' + 1 cross-session synthesis' : '';

      const parts: string[] = [];
      if (alreadyAnalyzed > 0) parts.push(`${alreadyAnalyzed} already done`);
      if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';

      console.log(`Found ${toAnalyze.length} sessions to analyze${detail}.`);
      console.log(`Estimated time: ~${estimatedMinutes} minutes`);
      console.log(`Estimated cost: ~${toAnalyze.length} LLM calls (session analysis)${crossNote}`);
      console.log();

      const confirmed = await promptConfirmation('Continue? [y/N] ');
      if (!confirmed) {
        console.log('Aborted.');
        process.exit(0);
      }
      console.log();
    }

    // Dry run mode
    if (opts.dryRun) {
      for (const session of toAnalyze) {
        const reason = opts.force ? 'forced' : 'new/changed';
        printDryRun(session.sessionId, session.userMessageCount, reason);
      }
      console.log();
      continue;
    }

    // Single-session analysis
    const results: AnalysisResult[] = [];
    for (let i = 0; i < toAnalyze.length; i++) {
      const session = toAnalyze[i];
      printAnalysisProgress(session.sessionId, session.userMessageCount);

      const result = await analyzeSingleSession(session, opts.verbose, opts.model as ModelName | undefined);
      results.push(result);

      // Save result and update audit
      await saveAnalysisResult(storeDir, result);
      audit = markSessionAnalyzed(audit, session.sessionId, promptVersion, result.insights.length);
      await saveAuditLog(storeDir, audit);

      const hasMoreWork = i < toAnalyze.length - 1 || (!opts.noCross && toAnalyze.length >= 2);
      printAnalysisDone(result.insights.length, result.stats.analysisTimeMs / 1000, !hasMoreWork);

      // Rate limiting: 1s delay between calls (except last)
      if (i < toAnalyze.length - 1) {
        await delay(1000);
      }
    }

    // Cross-session synthesis
    let crossPatterns: import('./analyzer/types.js').CrossSessionPattern[] = [];

    if (!opts.noCross && results.length >= 2) {
      const allInsights = results.flatMap((r) => r.insights);
      if (allInsights.length > 0) {
        const crossText = `Cross-session synthesis (${allInsights.length} insights from ${results.length} sessions)...`;
        console.log(substep(crossText));

        crossPatterns = await synthesizeCrossSessions(results, project.projectPath, opts.verbose, opts.model as ModelName | undefined);

        if (crossPatterns.length > 0) {
          await saveCrossSessionPatterns(storeDir, crossPatterns);
          audit = markCrossSessionDone(audit);
          await saveAuditLog(storeDir, audit);

          console.log(
            success(`${crossPatterns.length} cross-session pattern${crossPatterns.length === 1 ? '' : 's'} found`),
          );
        }
      }
    }

    console.log();
    printInsightResults(results, crossPatterns);

    // Accumulate IDs for the caller (used by run pipeline to scope suggest)
    allInsightIds.push(...results.flatMap((r) => r.insights.map((i) => i.id)));
    allCrossPatternIds.push(...crossPatterns.map((p) => p.id));
  }

  return { insightIds: allInsightIds, crossPatternIds: allCrossPatternIds };
}

// === Session detail command ===

async function runSessionDetail(projects: ProjectInfo[], opts: CLIOptions): Promise<void> {
  printHeader();

  if (opts.verbose) {
    printVerbose(`Found ${projects.length} project directories`);
  }

  const match = findSessionById(projects, opts.session!);
  if (!match) {
    printError(`Session not found: ${opts.session}`);
    process.exit(1);
  }

  const sessionInfo = await buildSessionInfo(
    match.session,
    match.project.projectPath,
    match.project.projectPathEncoded,
  );

  printSessionDetail(sessionInfo);
}

// === List command ===

async function runList(projects: ProjectInfo[], opts: CLIOptions): Promise<void> {
  printHeader();

  if (opts.verbose) {
    printVerbose(`Found ${projects.length} project directories`);
  }

  if (opts.project) {
    projects = filterByProject(projects, opts.project);
    if (projects.length === 0) {
      printError(`Project not found: ${opts.project}`);
      process.exit(1);
    }
  }

  if (opts.days) {
    projects = filterByDays(projects, opts.days);
  }

  if (opts.limit) {
    projects = limitSessions(projects, opts.limit);
  }

  let totalSessions = 0;
  let totalDurationMinutes = 0;

  for (const project of projects) {
    if (project.sessions.length === 0) {
      if (opts.verbose) {
        printVerbose(`Skipping empty project: ${project.projectPath}`);
      }
      continue;
    }

    printProjectHeader(project);

    const sessionInfos: SessionInfo[] = [];

    for (const sessionFile of project.sessions) {
      try {
        const info = await buildSessionInfo(
          sessionFile,
          project.projectPath,
          project.projectPathEncoded,
        );
        sessionInfos.push(info);

        if (opts.verbose && info.messages.length === 0) {
          printVerbose(`Session ${info.sessionId}: no messages parsed`);
        }
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : String(err);
        printWarning(
          `Failed to parse session ${sessionFile.sessionId}: ${msg}`,
        );
      }
    }

    printSessionsTable(sessionInfos);

    totalSessions += sessionInfos.length;
    totalDurationMinutes += sessionInfos.reduce(
      (sum, s) => sum + (s.durationMinutes ?? 0),
      0,
    );
  }

  const projectsWithSessions = projects.filter(
    (p) => p.sessions.length > 0,
  ).length;

  printSummary(projectsWithSessions, totalSessions, totalDurationMinutes);
}

// === Apply command ===

async function runApply(opts: ApplyOptions): Promise<void> {
  // Determine project root
  const startDir = opts.project ? resolve(opts.project) : process.cwd();
  const projectRoot = await findProjectRoot(startDir);

  if (!projectRoot) {
    printError(`Could not find project root from ${startDir}. No .git, package.json, or CLAUDE.md found.`);
    process.exit(1);
  }

  const applyBanner = buildBanner('Apply', projectRoot);
  for (const line of applyBanner) console.log(line);
  console.log();

  // Check Claude CLI (needed for --full pipeline)
  const cliAvailable = await checkCliAvailable();
  if (!cliAvailable) {
    printError('Claude Code CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  if (opts.verbose) {
    printVerbose(`Project root: ${projectRoot}`);
  }

  const storeDir = await initStoreDir(projectRoot);

  // Run full pipeline if --full or if no suggestions exist yet
  const existingSuggestions = await loadLatestSuggestionSet(storeDir);
  if (opts.full || !existingSuggestions) {
    if (!existingSuggestions && !opts.full) {
      console.log(secondary('No existing suggestions found. Running full pipeline...'));
      console.log();
    }

    // Run suggest with --full (which also runs analyze)
    await runSuggest({
      project: opts.project,
      all: opts.all,
      verbose: opts.verbose,
      full: true,
      limit: opts.limit,
      model: opts.model,
    });
  }

  // Load the latest suggestions
  const suggestionSet = await loadLatestSuggestionSet(storeDir);
  if (!suggestionSet || suggestionSet.suggestions.length === 0) {
    console.log('Your rules are up to date! Nothing to change.');
    console.log();
    return;
  }

  // Filter to pending suggestions only
  const pending = suggestionSet.suggestions.filter((s) => s.status === 'pending');
  if (pending.length === 0) {
    console.log('All suggestions have already been processed. Run "suggest" to generate new ones.');
    console.log();
    return;
  }

  // Run interactive review
  await runInteractiveReview(pending, projectRoot, storeDir, opts);
}

// === Init command ===

async function runInit(opts: ApplyOptions): Promise<void> {
  const projectRoot = opts.project ? resolve(opts.project) : process.cwd();

  const commandDir = join(projectRoot, '.claude', 'commands');
  const commandPath = join(commandDir, 'contextlinter.md');

  // Read the template from our own .claude/commands/
  const contextlinterRoot = dirname(new URL(import.meta.url).pathname);
  const templatePath = join(contextlinterRoot, '..', '.claude', 'commands', 'contextlinter.md');

  let template: string;
  try {
    template = await readFile(templatePath, 'utf-8');
  } catch {
    // Fallback: generate inline
    template = generateSlashCommandTemplate();
  }

  await mkdir(commandDir, { recursive: true });
  await writeFile(commandPath, template, 'utf-8');

  for (const line of buildBanner('Init', projectRoot)) {
    console.log(line);
  }
  console.log();
  console.log(step('Initialize Slash Command'));
  console.log(success(`Created ${commandPath}`, false));
  console.log(lastSub(secondary('You can now use /contextlinter in Claude Code to run the analysis pipeline.')));
  console.log();
}

function generateSlashCommandTemplate(): string {
  return `Run the ContextLinter analysis pipeline to suggest improvements to this project's rules files.

## Steps

1. Run the ContextLinter CLI to generate suggestions:
   \`\`\`bash
   npx contextlinter suggest --full --limit 10 --verbose
   \`\`\`

2. Read the latest suggestion set from \`.contextlinter/suggestions/\` (most recent JSON file).

3. Review each suggestion and present it to the user with the diff preview, showing:
   - The suggestion type (add/update/remove/consolidate)
   - Target file and section
   - The diff (lines to add/remove)
   - Confidence level and priority
   - Rationale

4. For each suggestion, ask the user:
   - **Accept** — apply this change to the target file
   - **Reject** — skip this suggestion
   - **Edit** — modify the suggested text before applying

5. Apply accepted changes to the appropriate rules files:
   - For "add" suggestions: create the file if needed, or append to the target section
   - For "update" suggestions: find and replace the old text with new text
   - For "remove" suggestions: find and delete the specified text
   - Create backup copies before modifying any file

6. Show a summary of what was changed.

## Notes
- If no suggestions are generated, tell the user their rules are up to date.
- Show the confidence level and rationale for each suggestion.
- When applying changes, create new files if they don't exist yet (e.g., .claude/rules/debugging.md).
- Create parent directories as needed.
- After applying, remind the user to review the changes with \`git diff\` and commit if satisfied.
`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err: unknown) => {
  printError(
    `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
