#!/usr/bin/env node
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { CLIOptions, ProjectInfo, SessionInfo } from './session-reader/types.js';
import type { AnalyzeOptions, AnalysisResult } from './analyzer/types.js';
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
  printDryRun,
  printError,
  printHeader,
  printNoRulesFound,
  printNothingToAnalyze,
  printProjectHeader,
  printRulesDetailed,
  printRulesOverview,
  printSessionDetail,
  printSessionsDebugList,
  printSkippedSummary,
  printSessionsTable,
  printSummary,
  printVerbose,
  printWarning,
} from './utils/logger.js';
import { initStoreDir } from './store/persistence.js';
import { cacheSession, getCachedSession } from './store/session-cache.js';
import { cacheRulesSnapshot, getCachedRulesSnapshot } from './store/rules-cache.js';
import {
  loadAuditLog,
  markSessionParsed,
  needsAnalysis,
  saveAuditLog,
} from './store/audit.js';
import { loadAnalysisResult } from './store/analysis-store.js';
import { checkCliAvailable, getPromptVersion, type ModelName } from './analyzer/llm-client.js';
import { isSessionAnalyzable } from './analyzer/preparer.js';
import { loadLatestSuggestionSet } from './store/suggestion-store.js';
import { runInteractiveReview } from './applier/interactive.js';
import { runWatch, type WatchOptions } from './watcher.js';
import { runPerSessionPipeline } from './pipeline/per-session.js';
import type { SessionPipelineResult } from './pipeline/types.js';
import { brand, color } from './ui/theme.js';
import { step, substep, success, secondary, tertiary, treeCont, lastSub, shortPath } from './ui/format.js';
import { buildBanner } from './ui/banner.js';


interface RulesOptions {
  project: string | undefined;
  list: boolean;
  verbose: boolean;
}

interface ParsedCLI {
  command: 'list' | 'analyze' | 'session-detail' | 'rules' | 'review' | 'init' | 'watch';
  options: CLIOptions;
  analyzeOptions: AnalyzeOptions;
  rulesOptions: RulesOptions;
  applyOptions: ApplyOptions;
  watchOptions: WatchOptions;
}

function printHelp(): void {
  console.log(`
${brand.emerald('contextlinter')} <command> [options]

${color.bold('Commands:')}
  analyze    Analyze sessions and generate rule suggestions
  review     Review and apply suggestions interactively
  list       Show analyzed sessions
  watch      Monitor for new sessions and auto-analyze
  rules      Show current rules overview
  init       Create slash command file

${color.bold('Options:')}
  --session <id>     Show details for a specific session
  --limit N          Analyze only N newest sessions
  --min-messages N   Minimum user messages to analyze (default: 2)
  --model <model>    LLM model: sonnet (default), opus, haiku
  --project <path>   Target specific project
  --all              Analyze all projects (default: CWD only)
  --yes              Auto-confirm (skip prompts)
  --dry-run          Preview without applying
  --verbose          Show detailed output

${color.bold('Watch options:')}
  --interval N       Poll interval in seconds (default: 300)
  --cooldown N       Wait before analyzing new session (default: 60)
  --no-suggest       Only analyze, don't generate suggestions

${color.bold('Review options:')}
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
      yes: { type: 'boolean', default: false },
      'min-confidence': { type: 'string' },
      'min-messages': { type: 'string' },
      model: { type: 'string' },
      interval: { type: 'string' },
      cooldown: { type: 'string' },
      'no-suggest': { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  if (!positionals.length && !values.session) {
    printHelp();
    process.exit(0);
  }

  const cmd = positionals[0];
  const knownCommands = ['analyze', 'review', 'list', 'rules', 'watch', 'init'] as const;
  if (cmd && !knownCommands.includes(cmd as any)) {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
  }
  const command: ParsedCLI['command'] = (cmd as typeof knownCommands[number]) ?? (values.session ? 'session-detail' : 'list');

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
    applyOptions: {
      project: values.project as string | undefined,
      all: Boolean(values.all),
      verbose: Boolean(values.verbose),
      yes: Boolean(values.yes),
      dryRun: Boolean(values['dry-run']),
      minConfidence: values['min-confidence']
        ? parseFloat(values['min-confidence'] as string)
        : undefined,
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

  if (cli.command === 'review') {
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

  if (cli.command === 'analyze') {
    await runAnalyzePipeline(projects, cli.analyzeOptions);
  } else if (cli.command === 'session-detail') {
    await runSessionDetail(projects, cli.options);
  } else {
    await runList(projects, cli.options);
  }
}

// === Shared project resolution ===

async function resolveProject(
  commandName: string,
  opts: { project?: string },
): Promise<string> {
  const startDir = opts.project ? resolve(opts.project) : process.cwd();
  const projectRoot = await findProjectRoot(startDir);

  for (const line of buildBanner(commandName, projectRoot ?? startDir)) {
    console.log(line);
  }
  console.log();

  if (!projectRoot) {
    printNoRulesFound();
    process.exit(1);
  }

  return projectRoot;
}

// === Rules command ===

async function runRules(opts: RulesOptions): Promise<void> {
  const projectRoot = await resolveProject('Rules', opts);

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

function promptConfirmation(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// === Session discovery helper ===

interface DiscoveryResult {
  toAnalyze: SessionInfo[];
  alreadyAnalyzed: number;
  alreadyAnalyzedIds: string[];
  skippedShort: number;
  storeDir: string;
}

/**
 * Discover, parse, filter, and determine which sessions need analysis for a single project.
 * Discover, parse, filter, and determine which sessions need analysis.
 */
async function discoverAnalyzableSessions(
  project: ProjectInfo,
  opts: AnalyzeOptions,
): Promise<DiscoveryResult> {
  const storeDir = await initStoreDir(project.projectPath);
  let audit = await loadAuditLog(storeDir);
  const promptVersion = await getPromptVersion('session-analysis');
  const minMessages = opts.minMessages ?? 2;

  // Verbose: show all sessions before filtering
  if (opts.verbose) {
    printSessionsDebugList(project.sessions, `All sessions for ${shortPath(project.projectPath)}`);
  }

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

      await cacheSession(storeDir, info);
      const fileStat = await stat(sessionFile.filePath);
      audit = markSessionParsed(audit, sessionFile.sessionId, fileStat.mtimeMs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      printWarning(`Failed to parse session ${sessionFile.sessionId}: ${msg}`);
    }
  }

  // Save audit after parsing
  await saveAuditLog(storeDir, audit);

  // Verbose: show parsed sessions
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

  // Filter out short sessions
  let skippedShort = 0;
  const analyzable: SessionInfo[] = [];
  for (const session of parsed) {
    if (!isSessionAnalyzable(session, minMessages)) {
      skippedShort++;
      continue;
    }
    analyzable.push(session);
  }

  if (skippedShort > 0) {
    printSkippedSummary(skippedShort);
  }

  // Apply --limit
  const limited = opts.limit ? analyzable.slice(0, opts.limit) : analyzable;
  if (opts.limit && opts.verbose) {
    console.log(treeCont(tertiary(`After --limit ${opts.limit} (from ${analyzable.length} analyzable): ${limited.length} sessions`)));
  }

  // Determine which need analysis
  const toAnalyze: SessionInfo[] = [];
  const alreadyAnalyzedIds: string[] = [];
  for (const session of limited) {
    const fileStat = await stat(session.filePath);
    const needs = opts.force || needsAnalysis(audit, session.sessionId, promptVersion, fileStat.mtimeMs);
    if (needs) {
      toAnalyze.push(session);
    } else {
      alreadyAnalyzedIds.push(session.sessionId);
    }
  }

  return { toAnalyze, alreadyAnalyzed: alreadyAnalyzedIds.length, alreadyAnalyzedIds, skippedShort, storeDir };
}

// === Run command (full pipeline) ===

async function runAnalyzePipeline(
  projects: ProjectInfo[],
  analyzeOpts: AnalyzeOptions,
): Promise<void> {
  const projectRoot = await resolveProject('Analyze', analyzeOpts);

  // Check Claude CLI
  const cliAvailable = await checkCliAvailable();
  if (!cliAvailable) {
    printError('Claude Code CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  // Filter projects
  let filteredProjects = projects;
  if (analyzeOpts.project) {
    filteredProjects = filterByProject(projects, analyzeOpts.project);
    if (filteredProjects.length === 0) {
      printError(`Project not found: ${analyzeOpts.project}`);
      process.exit(1);
    }
  }

  const project = filteredProjects[0];
  if (!project || project.sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  console.log(step('Analyzing Sessions'));

  const discovery = await discoverAnalyzableSessions(project, analyzeOpts);

  // Load existing analysis results for already-analyzed sessions
  const existingResults: AnalysisResult[] = [];
  for (const sessionId of discovery.alreadyAnalyzedIds) {
    const loaded = await loadAnalysisResult(discovery.storeDir, sessionId);
    if (loaded && loaded.insights.length > 0) {
      existingResults.push(loaded);
    }
  }

  if (discovery.toAnalyze.length === 0 && existingResults.length === 0) {
    if (discovery.alreadyAnalyzed > 0) {
      printNothingToAnalyze();
    } else {
      console.log(lastSub(secondary('No analyzable sessions found.')));
      console.log();
    }
    return;
  }

  printAnalysisSummaryLine(discovery.toAnalyze.length, discovery.alreadyAnalyzed, project.projectPath);

  // Prompt for confirmation if many sessions and not auto-confirmed
  if (discovery.toAnalyze.length > 10 && !analyzeOpts.yes && !analyzeOpts.limit) {
    const estimatedSeconds = discovery.toAnalyze.reduce((sum, s) => {
      return sum + 10 + Math.min(s.userMessageCount, 300) * 0.12;
    }, 0) + Math.max(0, discovery.toAnalyze.length - 1);
    const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
    const crossNote = !analyzeOpts.noCross && discovery.toAnalyze.length >= 2
      ? ' + 1 cross-session synthesis' : '';

    const parts: string[] = [];
    if (discovery.alreadyAnalyzed > 0) parts.push(`${discovery.alreadyAnalyzed} already done`);
    if (discovery.skippedShort > 0) parts.push(`${discovery.skippedShort} skipped`);
    const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';

    console.log(`Found ${discovery.toAnalyze.length} sessions to analyze${detail}.`);
    console.log(`Estimated time: ~${estimatedMinutes} minutes`);
    console.log(`Estimated cost: ~${discovery.toAnalyze.length} LLM calls (session analysis)${crossNote}`);
    console.log();

    const confirmed = await promptConfirmation('Continue? [y/N] ');
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
    console.log();
  }

  // Dry run mode
  if (analyzeOpts.dryRun) {
    for (const session of discovery.toAnalyze) {
      const reason = analyzeOpts.force ? 'forced' : 'new/changed';
      printDryRun(session.sessionId, session.userMessageCount, reason);
    }
    console.log();
    return;
  }

  const rulesSnapshot = await buildRulesSnapshot(projectRoot);

  // Run per-session pipeline
  const result = await runPerSessionPipeline(
    discovery.toAnalyze,
    discovery.storeDir,
    projectRoot,
    rulesSnapshot,
    {
      verbose: analyzeOpts.verbose ?? false,
      model: analyzeOpts.model as ModelName | undefined,
      noCross: analyzeOpts.noCross ?? false,
      dryRun: false,
      force: analyzeOpts.force ?? false,
      minMessages: analyzeOpts.minMessages ?? 2,
      yes: analyzeOpts.yes ?? false,
    },
    {
      onSessionAnalyzing: (sessionId, userMessageCount) => {
        printAnalysisProgress(sessionId, userMessageCount);
      },
      onSessionAnalyzed: (_sessionId, insightsFound, analysisTimeMs) => {
        printAnalysisDone(insightsFound, analysisTimeMs / 1000, false);
      },
      onSessionComplete: (r: SessionPipelineResult) => {
        if (r.suggestions.length > 0) {
          console.log(substep(secondary(`${r.suggestions.length} suggestion${r.suggestions.length === 1 ? '' : 's'} generated`)));
        }
      },
      onCrossSessionComplete: (patterns, suggestions) => {
        if (patterns.length > 0) {
          console.log(
            success(`${patterns.length} cross-session pattern${patterns.length === 1 ? '' : 's'} found`),
          );
        }
        if (suggestions.length > 0) {
          console.log(substep(secondary(`${suggestions.length} cross-session suggestion${suggestions.length === 1 ? '' : 's'}`)));
        }
      },
    },
    existingResults,
  );

  console.log();

  if (result.allSuggestions.length === 0) {
    console.log('No suggestions generated.');
    return;
  }

  const n = result.stats.suggestionsGenerated;
  console.log(step(`${n} suggestion${n === 1 ? '' : 's'} ready`));
  console.log(lastSub(`Run ${brand.emerald('contextlinter review')} to apply`));
  console.log();
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
        if (!info.firstTimestamp) {
          if (opts.verbose) {
            printVerbose(`Session ${info.sessionId}: no messages parsed`);
          }
          continue;
        }
        sessionInfos.push(info);
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

// === Review command ===

async function runApply(opts: ApplyOptions): Promise<void> {
  const projectRoot = await resolveProject('Review', opts);

  if (opts.verbose) {
    printVerbose(`Project root: ${projectRoot}`);
  }

  const storeDir = await initStoreDir(projectRoot);

  // Load saved suggestions
  const suggestionSet = await loadLatestSuggestionSet(storeDir);
  if (!suggestionSet || suggestionSet.suggestions.length === 0) {
    console.log(`No suggestions found. Run ${brand.emerald('contextlinter analyze')} first.`);
    console.log();
    return;
  }

  // Filter to pending suggestions only
  const pending = suggestionSet.suggestions.filter((s) => s.status === 'pending');
  if (pending.length === 0) {
    console.log(`All suggestions have been reviewed. Run ${brand.emerald('contextlinter analyze')} to generate new ones.`);
    console.log();
    return;
  }

  // Show summary
  const stats = suggestionSet.stats;
  console.log(step(`${pending.length} suggestion${pending.length === 1 ? '' : 's'} to review`));
  console.log(treeCont(`Priority: ${stats.byPriority.high} high, ${stats.byPriority.medium} medium, ${stats.byPriority.low} low`));
  console.log(lastSub(`Types: ${stats.byType.add} add, ${stats.byType.update} update, ${stats.byType.remove} remove`));
  console.log();

  // Run interactive review
  await runInteractiveReview(pending, projectRoot, storeDir, opts);
}

// === Init command ===

async function runInit(opts: ApplyOptions): Promise<void> {
  const projectRoot = opts.project ? resolve(opts.project) : process.cwd();

  // Check if project has CLAUDE.md or .claude/rules/
  const hasRules = await hasRulesFiles(projectRoot);

  for (const line of buildBanner('Init', projectRoot)) {
    console.log(line);
  }
  console.log();

  if (!hasRules) {
    printNoRulesFound();
    process.exit(1);
  }

  const commandDir = join(projectRoot, '.claude', 'commands');
  const commandPath = join(commandDir, 'contextlinter.md');

  const template = generateSlashCommandTemplate();

  await mkdir(commandDir, { recursive: true });
  await writeFile(commandPath, template, 'utf-8');

  console.log(step('Initialize Slash Command'));
  console.log(success(`Created ${commandPath}`, false));
  console.log(lastSub(secondary('Run "npx contextlinter analyze" in your terminal first, then use /contextlinter in Claude Code to review and apply suggestions.')));
  console.log();
}

async function hasRulesFiles(projectRoot: string): Promise<boolean> {
  try {
    await access(join(projectRoot, 'CLAUDE.md'));
    return true;
  } catch { /* not found */ }
  try {
    await access(join(projectRoot, '.claude', 'rules'));
    return true;
  } catch { /* not found */ }
  return false;
}

function generateSlashCommandTemplate(): string {
  return `Review and apply ContextLinter suggestions to this project's rules files.

## Prerequisites

Run the analysis pipeline in your terminal first:
\`\`\`
npx contextlinter analyze
\`\`\`

## Steps

1. Check if suggestions exist:
   \`\`\`bash
   ls -t .contextlinter/suggestions/*.json 2>/dev/null | head -1
   \`\`\`

   If no files found, tell the user:
   > No suggestions found. Run this in your terminal first:
   > \`\`\`
   > npx contextlinter analyze
   > \`\`\`
   > This analyzes your Claude Code sessions and generates rule suggestions.
   > It takes a few minutes (one LLM call per session).
   Then STOP.

2. Read and parse the latest suggestion file (cat the file from step 1).
   Extract the \`suggestions\` array, \`generatedAt\`, and \`stats\`.

3. Show diagnostic summary:
   > **ContextLinter suggestions** (generated {relative time from generatedAt})
   > {stats.total} suggestions: {stats.byPriority.high} high, {stats.byPriority.medium} medium, {stats.byPriority.low} low priority
   > Types: {stats.byType.add} add, {stats.byType.update} update, {stats.byType.remove} remove

   If generatedAt is older than 7 days, warn:
   > These suggestions are from {date}. Consider running \`npx contextlinter analyze\` again for fresh analysis.

4. Filter to suggestions with \`status === "pending"\` only.
   If none remain, tell user: "All suggestions have been reviewed. Run \`npx contextlinter analyze\` again to generate new ones." Then STOP.

5. For each pending suggestion, present it showing:
   - [index/total] title
   - Type (ADD/UPDATE/REMOVE), target file (\`targetFile\`) + section (\`targetSection\`)
   - Priority + confidence
   - Diff: \`diff.addedLines\` as \`+ line\`, \`diff.removedLines\` as \`- line\`
   - Rationale (\`rationale\`)

6. For each suggestion, ask the user:
   - **Accept** — apply this change to the target file
   - **Reject** — skip this suggestion
   - **Edit** — modify the suggested text before applying

7. Apply accepted changes to the appropriate rules files:
   - For "add" suggestions: append to the target section (or end of file). Create file if needed.
   - For "update" suggestions: find the removedLines text and replace with addedLines
   - For "remove" suggestions: find and delete the removedLines text
   - Create parent directories as needed

8. Show a summary of what was changed and remind the user to review with \`git diff\`.
`;
}

main().catch((err: unknown) => {
  printError(
    `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
