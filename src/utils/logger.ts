import chalk from 'chalk';
import type {
  NormalizedMessage,
  ProjectInfo,
  SessionFileInfo,
  SessionInfo,
} from '../session-reader/types.js';
import type {
  AnalysisResult,
  CrossSessionPattern,
  Insight,
  InsightCategory,
} from '../analyzer/types.js';
import type { RulesFile, RulesSnapshot } from '../rules-reader/types.js';
import type { Suggestion, SuggestionSet } from '../suggester/types.js';
import { formatFileSize } from './paths.js';

const VERSION = '0.1.0';

export function printHeader(): void {
  console.log(
    chalk.green(`==> `) + chalk.bold(`ContextLinter Session Reader v${VERSION}`),
  );
  console.log();
}

export function printProjectHeader(project: ProjectInfo): void {
  console.log(chalk.bold(`Project: ${project.projectPath}`));
  console.log(chalk.dim(`   Sessions: ${project.sessions.length}`));
}

export function printSessionsTable(sessions: SessionInfo[]): void {
  if (sessions.length === 0) {
    console.log(chalk.dim('   No sessions found.'));
    console.log();
    return;
  }

  const header = `   ${'#'.padStart(3)}   ${'Date'.padEnd(10)}   ${'Duration'.padEnd(8)}   ${'Messages'.padEnd(8)}   ${'Tools'.padEnd(5)}   Size`;
  const separator = `   ${'─'.repeat(3)}──${'─'.repeat(10)}──${'─'.repeat(8)}──${'─'.repeat(8)}──${'─'.repeat(5)}──${'─'.repeat(7)}`;

  console.log(chalk.dim(header));
  console.log(chalk.dim(separator));

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const num = String(i + 1).padStart(3);
    const date = s.firstTimestamp
      ? new Date(s.firstTimestamp).toISOString().slice(0, 10)
      : '??????????';
    const duration = s.durationMinutes !== null
      ? `${s.durationMinutes} min`.padEnd(8)
      : '?'.padEnd(8);
    const msgs = `${s.userMessageCount}/${s.assistantMessageCount}`.padEnd(8);
    const tools = String(s.toolUseCount).padEnd(5);
    const size = formatFileSize(s.fileSize);

    console.log(
      `   ${chalk.bold(num)}  ${date}  ${duration}  ${msgs}  ${tools}  ${size}`,
    );
  }

  console.log();
}

export function printSummary(
  totalProjects: number,
  totalSessions: number,
  totalDurationMinutes: number,
): void {
  const hours = (totalDurationMinutes / 60).toFixed(1);
  console.log(
    chalk.green(`==> `) + chalk.bold(`Summary`),
  );
  console.log(
    `    ${chalk.bold(String(totalProjects))} projects, ${chalk.bold(String(totalSessions))} sessions, ${chalk.bold(hours + 'h')} total`,
  );
  console.log();
}

export function printSessionDetail(session: SessionInfo): void {
  const dateRange = formatDateRange(session.firstTimestamp, session.lastTimestamp);
  const duration = session.durationMinutes !== null
    ? `(${session.durationMinutes} min)`
    : '';

  console.log(chalk.green(`==> `) + chalk.bold(`Session: ${session.sessionId}`));
  console.log(`    Project: ${session.projectPath}`);
  console.log(`    Date: ${dateRange} ${duration}`);
  console.log(
    `    Messages: ${session.userMessageCount} user, ${session.assistantMessageCount} assistant, ${session.toolUseCount} tool uses`,
  );
  if (session.summary) {
    console.log(chalk.dim(`    Summary: ${session.summary}`));
  }
  console.log();

  for (const msg of session.messages) {
    printMessage(msg);
  }
}

function printMessage(msg: NormalizedMessage): void {
  const time = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '??:??';

  const roleLabel = msg.role.toUpperCase();
  const roleColor =
    msg.role === 'user'
      ? chalk.bold
      : chalk.dim;

  console.log(`${chalk.dim(`[${time}]`)} ${roleColor(roleLabel + ':')}`);

  if (msg.textContent) {
    const lines = msg.textContent.split('\n');
    const preview = lines.slice(0, 6);
    for (const line of preview) {
      console.log(`  ${line}`);
    }
    if (lines.length > 6) {
      console.log(chalk.dim(`  ... (${lines.length - 6} more lines)`));
    }
  }

  for (const tool of msg.toolUses) {
    const inputPreview = formatToolInput(tool.name, tool.input);
    console.log(chalk.dim(`  ${tool.name}${inputPreview ? ': ' + inputPreview : ''}`));
  }

  for (const result of msg.toolResults) {
    if (result.content) {
      const preview = result.content.slice(0, 80).replace(/\n/g, ' ');
      console.log(chalk.dim(`  \u2190 ${preview}${result.content.length > 80 ? '...' : ''}`));
    }
  }

  console.log();
}

function formatToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';

  const obj = input as Record<string, unknown>;

  // Show the most useful field for common tools
  if (name === 'Bash' && typeof obj.command === 'string') {
    return truncate(obj.command, 80);
  }
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && typeof obj.file_path === 'string') {
    return obj.file_path as string;
  }
  if (name === 'Grep' && typeof obj.pattern === 'string') {
    return `/${obj.pattern}/`;
  }
  if (name === 'Glob' && typeof obj.pattern === 'string') {
    return obj.pattern as string;
  }
  if (name === 'Task' && typeof obj.description === 'string') {
    return obj.description as string;
  }

  return '';
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}

function formatDateRange(
  first: string | null,
  last: string | null,
): string {
  if (!first) return 'Unknown date';

  const startDate = new Date(first);
  const dateStr = startDate.toISOString().slice(0, 10);
  const startTime = startDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  if (!last) return `${dateStr} ${startTime}`;

  const endTime = new Date(last).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return `${dateStr} ${startTime} - ${endTime}`;
}

export function printWarning(message: string): void {
  console.log(chalk.yellow(`Warning: ${message}`));
}

export function printError(message: string): void {
  console.log(chalk.red(`\u2717 ${message}`));
}

export function printVerbose(message: string): void {
  console.log(chalk.dim(`    ${message}`));
}

// === Analyzer output ===

const CATEGORY_LABELS: Record<InsightCategory, string> = {
  missing_project_knowledge: 'MISSING PROJECT KNOWLEDGE',
  repeated_correction: 'REPEATED CORRECTION',
  rejected_approach: 'REJECTED APPROACH',
  intent_clarification: 'INTENT CLARIFICATION',
  convention_establishment: 'CONVENTION ESTABLISHMENT',
  tool_command_correction: 'TOOL/COMMAND CORRECTION',
  tool_usage_pattern: 'TOOL USAGE PATTERN',
};

export function printAnalyzerHeader(): void {
  console.log(
    chalk.green(`==> `) + chalk.bold(`ContextLinter Analyzer v${VERSION}`),
  );
  console.log();
}

export function printAnalysisProgress(
  sessionId: string,
  userMessages: number,
): void {
  const shortId = sessionId.slice(0, 12);
  console.log(`    Analyzing session ${shortId} (${userMessages} user messages)...`);
}

export function printAnalysisDone(insightCount: number, durationSec: number): void {
  if (insightCount > 0) {
    console.log(chalk.green(`  \u2713 ${insightCount} insight${insightCount === 1 ? '' : 's'} found`) + chalk.dim(` (${durationSec.toFixed(1)}s)`));
  } else {
    console.log(chalk.dim(`    No insights found (${durationSec.toFixed(1)}s)`));
  }
}

export function printSessionSkipped(sessionId: string, reason: string): void {
  const shortId = sessionId.slice(0, 12);
  console.log(chalk.dim(`    Skipping ${shortId}: ${reason}`));
}

export function printSkippedSummary(count: number, minMessages: number): void {
  if (count > 0) {
    console.log(chalk.dim(`    Skipped ${count} session${count === 1 ? '' : 's'} (too short, <${minMessages} user messages)`));
  }
}

export function printSessionsDebugList(sessions: SessionFileInfo[], label: string): void {
  console.log(chalk.dim(`    ${label} (${sessions.length} sessions):`));
  for (const s of sessions) {
    const shortId = s.sessionId.slice(0, 12);
    const date = s.createdAt
      ? s.createdAt.toISOString().slice(0, 16).replace('T', ' ')
      : s.modifiedAt.toISOString().slice(0, 16).replace('T', ' ');
    const source = s.createdAt ? '' : chalk.dim(' (mtime)');
    const size = formatFileSize(s.fileSize);
    console.log(chalk.dim(`             Session ${shortId} | ${date}${source} | ${size}`));
  }
  console.log();
}

export function printInsightResults(
  results: AnalysisResult[],
  crossPatterns: CrossSessionPattern[],
  projectPath: string,
): void {
  const allInsights = results.flatMap((r) => r.insights);
  if (allInsights.length === 0 && crossPatterns.length === 0) {
    console.log(chalk.dim('No insights found across analyzed sessions.'));
    console.log();
    return;
  }

  console.log(chalk.green(`==> `) + chalk.bold(`Results for: ${projectPath}`));
  console.log();

  // Group insights by category
  const byCategory = new Map<InsightCategory, Insight[]>();
  for (const insight of allInsights) {
    const existing = byCategory.get(insight.category) ?? [];
    existing.push(insight);
    byCategory.set(insight.category, existing);
  }

  for (const [category, insights] of byCategory) {
    printCategoryBlock(category, insights);
  }

  // Cross-session patterns
  if (crossPatterns.length > 0) {
    console.log(chalk.bold(`Cross-session patterns (${crossPatterns.length})`));
    console.log();
    for (const pattern of crossPatterns) {
      printCrossPattern(pattern);
    }
    console.log();
  }

  // Summary
  const totalAnalysisTime = results.reduce((sum, r) => sum + r.stats.analysisTimeMs, 0);
  const sessionsWithInsights = results.filter((r) => r.insights.length > 0).length;

  console.log(
    chalk.green(`==> `) + chalk.bold(`Summary`),
  );
  console.log(
    `    ${chalk.bold(String(allInsights.length))} insights from ${sessionsWithInsights}/${results.length} sessions` +
    (crossPatterns.length > 0 ? `, ${chalk.bold(String(crossPatterns.length))} cross-session patterns` : ''),
  );
  console.log(chalk.dim(`    Analysis time: ${(totalAnalysisTime / 1000).toFixed(1)}s total`));
  console.log();
}

function printCategoryBlock(category: InsightCategory, insights: Insight[]): void {
  const label = CATEGORY_LABELS[category];
  console.log(chalk.bold(`${label} (${insights.length} insight${insights.length === 1 ? '' : 's'})`));
  console.log();

  for (const insight of insights) {
    printInsight(insight);
  }
}

function printInsight(insight: Insight): void {
  const confPct = Math.round(insight.confidence * 100);
  const confLabel = confPct >= 80 ? 'HIGH' : confPct >= 60 ? 'MED' : 'LOW';

  console.log(`    ${chalk.bold(confLabel)}  ${chalk.bold(String(confPct) + '%')}  ${insight.title}`);
  console.log(chalk.dim(`                ${insight.description}`));

  if (insight.evidence.length > 0) {
    console.log(chalk.dim(`                Evidence:`));
    for (const ev of insight.evidence) {
      const roleTag = ev.role === 'user' ? '[USER]' : '[ASSISTANT]';
      const text = ev.text.length > 80 ? ev.text.slice(0, 77) + '...' : ev.text;
      console.log(chalk.dim(`                  ${roleTag} "${text}"`));
    }
  }

  if (insight.suggestedRule) {
    console.log(`                Suggested rule: ${insight.suggestedRule}`);
  }

  console.log(chalk.dim(`                Action: ${insight.actionHint}`));
  console.log();
}

function printCrossPattern(pattern: CrossSessionPattern): void {
  const confPct = Math.round(pattern.confidence * 100);
  const sessionCount = pattern.occurrences.length;

  console.log(`    ${chalk.bold(String(confPct) + '%')}  ${pattern.title}`);
  console.log(chalk.dim(`          ${pattern.description}`));
  console.log(chalk.dim(`          Sessions: ${sessionCount}`));

  if (pattern.suggestedRule) {
    console.log(`          Suggested rule: ${pattern.suggestedRule}`);
  }
  console.log();
}

export function printAnalysisSummaryLine(
  toAnalyze: number,
  alreadyAnalyzed: number,
  projectPath: string,
): void {
  console.log(`Analyzing project: ${projectPath}`);
  const skipMsg = alreadyAnalyzed > 0 ? ` (${alreadyAnalyzed} already analyzed, skipped)` : '';
  console.log(`Sessions to analyze: ${chalk.bold(String(toAnalyze))}${skipMsg}`);
  console.log();
}

export function printDryRun(sessionId: string, userMessages: number, reason: string): void {
  const shortId = sessionId.slice(0, 12);
  console.log(chalk.dim(`  [dry-run] Would analyze ${shortId} (${userMessages} user msgs) \u2014 ${reason}`));
}

export function printNothingToAnalyze(): void {
  console.log(chalk.dim('Nothing new to analyze. Run with --force to re-analyze.'));
  console.log();
}

// === Rules Reader output ===

export function printRulesHeader(): void {
  console.log(
    chalk.green(`==> `) + chalk.bold(`ContextLinter Rules Reader v${VERSION}`),
  );
  console.log();
}

export function printRulesOverview(snapshot: RulesSnapshot): void {
  console.log(`Project root: ${chalk.dim(snapshot.projectRoot)}`);
  console.log();

  if (snapshot.files.length === 0) {
    console.log(chalk.dim('No rules files found. This project has no CLAUDE.md or .claude/rules/.'));
    console.log();
    return;
  }

  console.log(chalk.bold(`Rules files found: ${snapshot.files.length}`));
  console.log();

  for (const file of snapshot.files) {
    const name = file.relativePath.padEnd(35);
    const scope = file.scope.padEnd(14);
    const ruleCount = `${file.rules.length} rule${file.rules.length === 1 ? '' : 's'}`.padEnd(10);
    const size = formatFileSize(file.sizeBytes);
    console.log(`  ${name} ${chalk.dim('|')} ${scope} ${chalk.dim('|')} ${ruleCount} ${chalk.dim('|')} ${size}`);
  }
  console.log();

  // Stats
  const { stats } = snapshot;
  console.log(chalk.bold('Stats'));
  console.log();
  console.log(`  Total rules:    ${chalk.bold(String(stats.totalRules))}`);
  console.log(`  By scope:       ${stats.byScope.global} global, ${stats.byScope.project} project, ${stats.byScope.project_local} local, ${stats.byScope.subdirectory} subdir`);
  console.log(`  By format:      ${stats.byFormat.bullet_point} bullet, ${stats.byFormat.paragraph} paragraph, ${stats.byFormat.command} command, ${stats.byFormat.emphatic} emphatic`);

  if (stats.importCount > 0) {
    const importPaths = snapshot.files
      .flatMap((f) => f.imports)
      .map((imp) => `@${imp.path}`);
    console.log(`  Imports:        ${stats.importCount} (${importPaths.join(', ')})`);
  }

  const emphaticCount = snapshot.allRules.filter((r) => r.emphasis === 'important').length;
  if (emphaticCount > 0) {
    console.log(`  Emphasis:       ${emphaticCount} rules with IMPORTANT/MUST/NEVER`);
  }
  console.log();
}

export function printRulesDetailed(snapshot: RulesSnapshot): void {
  for (const file of snapshot.files) {
    printRulesFileDetail(file);
  }
}

function printRulesFileDetail(file: RulesFile): void {
  console.log(chalk.bold(`${file.relativePath} (${file.scope}, ${file.rules.length} rule${file.rules.length === 1 ? '' : 's'})`));
  console.log();

  if (file.rules.length === 0) {
    console.log(chalk.dim('  (no rules parsed)'));
    console.log();
    return;
  }

  // Group rules by section
  let currentSection: string | null | undefined;
  for (const rule of file.rules) {
    if (rule.section !== currentSection) {
      currentSection = rule.section;
      if (currentSection) {
        const sectionRules = file.rules.filter((r) => r.section === currentSection);
        console.log(chalk.bold(`  ## ${currentSection} (${sectionRules.length} rules)`));
      }
    }

    const lineRef = chalk.dim(`[L${rule.lineStart}]`);
    const emphasisTag = rule.emphasis === 'important' ? 'IMPORTANT ' : '';

    const textPreview = rule.text.length > 100
      ? rule.text.slice(0, 97) + '...'
      : rule.text;

    // Replace newlines with spaces for display
    const displayText = textPreview.replace(/\n/g, ' ');

    console.log(`    ${lineRef} ${emphasisTag}"${displayText}"`);
  }

  console.log();
}

export function printRulesFileLargeWarning(path: string, lineCount: number): void {
  console.log(chalk.yellow(`Warning: ${path} is very large (${lineCount} lines). Consider splitting into .claude/rules/.`));
}

// === Suggestion Generator output ===

export function printSuggesterHeader(): void {
  console.log(
    chalk.green(`==> `) + chalk.bold(`ContextLinter Suggestion Generator v${VERSION}`),
  );
  console.log();
}

export function printSuggestionLoadingSummary(
  insightCount: number,
  sessionInsightCount: number,
  crossPatternCount: number,
  ruleCount: number,
  fileCount: number,
  filteredOut: number,
): void {
  console.log('Loading data...');
  console.log(`  Insights: ${chalk.bold(String(insightCount))} (${sessionInsightCount} from sessions, ${crossPatternCount} cross-session patterns)`);
  console.log(`  Rules: ${chalk.bold(String(ruleCount))} rules across ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  if (filteredOut > 0) {
    console.log(`  Filtered: ${insightCount} insights (${filteredOut} below confidence threshold)`);
  }
  console.log();
}

export function printSuggestionResults(
  set: SuggestionSet,
  skipped: Array<{ title: string; reason: string }>,
): void {
  const { suggestions, stats } = set;

  console.log(chalk.green(`==> `) + chalk.bold(`Suggestions for: ${set.projectPath}`));
  console.log();

  if (suggestions.length === 0) {
    console.log(chalk.dim('No suggestions generated. Rules are up to date.'));
    console.log();
    return;
  }

  // Group by target file
  const byFile = new Map<string, Suggestion[]>();
  for (const s of suggestions) {
    const existing = byFile.get(s.targetFile) ?? [];
    existing.push(s);
    byFile.set(s.targetFile, existing);
  }

  for (const [file, fileSuggestions] of byFile) {
    printSuggestionFileGroup(file, fileSuggestions);
  }

  // Skipped
  if (skipped.length > 0) {
    console.log(chalk.dim(`  Skipped (${skipped.length}):`));
    for (const s of skipped) {
      console.log(chalk.dim(`    "${s.title}" \u2014 ${s.reason}`));
    }
    console.log();
  }

  // Summary line
  const typeCounts: string[] = [];
  if (stats.byType.add > 0) typeCounts.push(`${stats.byType.add} add`);
  if (stats.byType.update > 0) typeCounts.push(`${stats.byType.update} update`);
  if (stats.byType.remove > 0) typeCounts.push(`${stats.byType.remove} remove`);
  if (stats.byType.consolidate > 0) typeCounts.push(`${stats.byType.consolidate} consolidate`);

  console.log(
    chalk.green(`==> `) + chalk.bold(`Summary: ${stats.total} suggestion${stats.total === 1 ? '' : 's'} (${typeCounts.join(', ')})`),
  );
  if (stats.insightsSkipped > 0) {
    console.log(chalk.dim(`    ${stats.insightsSkipped} insights skipped (already covered)`));
  }
  console.log(chalk.dim(`    Current rules: ${stats.estimatedRulesAfter - stats.total} \u2192 estimated after: ${stats.estimatedRulesAfter}`));
  console.log();
}

function printSuggestionFileGroup(file: string, suggestions: Suggestion[]): void {
  console.log(chalk.bold(`${file} (${suggestions.length} change${suggestions.length === 1 ? '' : 's'})`));
  console.log();

  for (const s of suggestions) {
    printSuggestionItem(s);
  }
}

function printSuggestionItem(s: Suggestion): void {
  const confPct = Math.round(s.confidence * 100);
  const priorityLabel = formatPriorityLabel(s.priority);
  const typeLabel = s.type === 'add' ? 'Add rule' : s.type === 'update' ? 'Update rule' : s.type === 'remove' ? 'Remove rule' : 'Consolidate';

  console.log(`  ${priorityLabel}  ${chalk.bold(String(confPct) + '%')}  ${typeLabel}: ${s.title}`);
  console.log(chalk.dim(`                ${s.rationale}`));

  if (s.targetSection) {
    console.log(chalk.dim(`                Section: ## ${s.targetSection}`));
  }

  // Print diff
  printSuggestionDiff(s);

  console.log();
}

function printSuggestionDiff(s: Suggestion): void {
  const { diff } = s;

  if (diff.parts && diff.parts.length > 0) {
    // Consolidation: show each part
    for (const part of diff.parts) {
      if (part.removedLines) {
        for (const line of part.removedLines) {
          console.log(chalk.red(`                - ${line.content}`));
        }
      }
      if (part.addedLines) {
        for (const line of part.addedLines) {
          console.log(chalk.green(`                + ${line.content}`));
        }
      }
    }
    return;
  }

  if (diff.removedLines) {
    for (const line of diff.removedLines) {
      console.log(chalk.red(`                - ${line.content}`));
    }
  }

  if (diff.addedLines) {
    for (const line of diff.addedLines) {
      console.log(chalk.green(`                + ${line.content}`));
    }
  }
}

function formatPriorityLabel(priority: string): string {
  switch (priority) {
    case 'high':
      return chalk.bold('HIGH');
    case 'medium':
      return chalk.bold('MED ');
    case 'low':
      return chalk.bold('LOW ');
    default:
      return '    ';
  }
}

export function printSuggestionGenerating(batchCount?: number): void {
  if (batchCount && batchCount > 1) {
    console.log(`    Generating suggestions (${batchCount} batches)...`);
  } else {
    console.log('    Generating suggestions...');
  }
}

export function printSuggestionBatchProgress(batchIdx: number, batchCount: number): void {
  console.log(chalk.dim(`    Batch ${batchIdx + 1} of ${batchCount}...`));
}

export function printSuggestionGenerated(count: number, skippedCount: number, durationSec: number): void {
  if (count > 0) {
    const skippedMsg = skippedCount > 0 ? ` (${skippedCount} insights skipped \u2014 already covered)` : '';
    console.log(chalk.green(`  \u2713 ${count} suggestion${count === 1 ? '' : 's'} generated${skippedMsg}`));
  } else {
    console.log(chalk.dim(`    No suggestions generated (${durationSec.toFixed(1)}s)`));
  }
  console.log();
}
