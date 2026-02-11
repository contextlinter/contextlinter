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
import { color, icon } from '../ui/theme.js';
import {
  step,
  substep,
  lastSub,
  success,
  error,
  warn,
  filePath,
  secondary,
  tertiary,
  treeCont,
  diffAdd,
  diffRemove,
  priorityLabel,
  shortPath,
} from '../ui/format.js';
import { buildBanner } from '../ui/banner.js';

export function printHeader(): void {
  for (const line of buildBanner('Sessions', undefined, { Scope: 'all projects' })) {
    console.log(line);
  }
  console.log();
}

export function printProjectHeader(project: ProjectInfo): void {
  console.log(step(`Project: ${shortPath(project.projectPath)}`));
  console.log(lastSub(`Sessions: ${project.sessions.length}`));
}

export function printSessionsTable(sessions: SessionInfo[]): void {
  if (sessions.length === 0) {
    console.log(secondary('   No sessions found.'));
    console.log();
    return;
  }

  const header = `   ${'#'.padStart(3)}   ${'Date'.padEnd(10)}   ${'Duration'.padEnd(8)}   ${'Messages'.padEnd(8)}   ${'Tools'.padEnd(5)}   Size`;
  const separator = `   ${'─'.repeat(3)}──${'─'.repeat(10)}──${'─'.repeat(8)}──${'─'.repeat(8)}──${'─'.repeat(5)}──${'─'.repeat(7)}`;

  console.log(tertiary(header));
  console.log(tertiary(separator));

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
      `   ${color.bold(num)}  ${date}  ${duration}  ${msgs}  ${tools}  ${size}`,
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
  console.log(step('Summary'));
  console.log(
    lastSub(`${color.bold(String(totalProjects))} projects, ${color.bold(String(totalSessions))} sessions, ${color.bold(hours + 'h')} total`),
  );
  console.log();
}

export function printSessionDetail(session: SessionInfo): void {
  const dateRange = formatDateRange(session.firstTimestamp, session.lastTimestamp);
  const duration = session.durationMinutes !== null
    ? `(${session.durationMinutes} min)`
    : '';

  console.log(step(`Session: ${session.sessionId}`));
  console.log(substep(`Project: ${shortPath(session.projectPath)}`));
  console.log(substep(`Date: ${dateRange} ${duration}`));
  console.log(
    substep(`Messages: ${session.userMessageCount} user, ${session.assistantMessageCount} assistant, ${session.toolUseCount} tool uses`),
  );
  if (session.summary) {
    console.log(substep(secondary(`Summary: ${session.summary}`)));
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
      ? color.bold
      : secondary;

  console.log(`${tertiary(`[${time}]`)} ${roleColor(roleLabel + ':')}`);

  if (msg.textContent) {
    const lines = msg.textContent.split('\n');
    const preview = lines.slice(0, 6);
    for (const line of preview) {
      console.log(`  ${line}`);
    }
    if (lines.length > 6) {
      console.log(secondary(`  ... (${lines.length - 6} more lines)`));
    }
  }

  for (const tool of msg.toolUses) {
    const inputPreview = formatToolInput(tool.name, tool.input);
    console.log(tertiary(`  ${tool.name}${inputPreview ? ': ' + inputPreview : ''}`));
  }

  for (const result of msg.toolResults) {
    if (result.content) {
      const preview = result.content.slice(0, 80).replace(/\n/g, ' ');
      console.log(tertiary(`  \u2190 ${preview}${result.content.length > 80 ? '...' : ''}`));
    }
  }

  console.log();
}

function formatToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';

  const obj = input as Record<string, unknown>;

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
  console.log(warn(message));
}

export function printError(message: string): void {
  console.log(error(message));
}

export function printVerbose(message: string): void {
  console.log(treeCont(tertiary(message)));
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

export function printAnalyzerHeader(projectRoot?: string): void {
  for (const line of buildBanner('Analyze', projectRoot)) {
    console.log(line);
  }
  console.log();
  console.log(step('Analyzing Sessions'));
}

export function printAnalysisProgress(
  sessionId: string,
  userMessages: number,
): void {
  const shortId = sessionId.slice(0, 8);
  console.log(substep(`Analyzing ${shortId} (${userMessages} msgs)...`));
}

export function printAnalysisDone(insightCount: number, durationSec: number, isLast = true): void {
  if (insightCount > 0) {
    console.log(success(`${insightCount} insight${insightCount === 1 ? '' : 's'} found ${secondary(`(${durationSec.toFixed(1)}s)`)}`, isLast));
  } else {
    if (isLast) {
      console.log(lastSub(secondary(`No insights found (${durationSec.toFixed(1)}s)`)));
    } else {
      console.log(substep(secondary(`No insights found (${durationSec.toFixed(1)}s)`)));
    }
  }
}

export function printSessionSkipped(sessionId: string, reason: string): void {
  const shortId = sessionId.slice(0, 8);
  console.log(substep(secondary(`Skipped ${shortId}: ${reason}`)));
}

export function printSkippedSummary(count: number): void {
  if (count > 0) {
    console.log(substep(secondary(`Skipped ${count} session${count === 1 ? '' : 's'} (too short)`)));
  }
}

export function printSessionsDebugList(sessions: SessionFileInfo[], label: string): void {
  console.log(substep(tertiary(`${label} (${sessions.length} sessions)`)));
  for (const s of sessions) {
    const shortId = s.sessionId.slice(0, 8);
    const date = s.createdAt
      ? s.createdAt.toISOString().slice(0, 16).replace('T', ' ')
      : s.modifiedAt.toISOString().slice(0, 16).replace('T', ' ');
    const source = s.createdAt ? '' : ' (mtime)';
    const size = formatFileSize(s.fileSize);
    console.log(treeCont(tertiary(`Session ${shortId} | ${date}${source} | ${size}`)));
  }
}

export function printInsightResults(
  results: AnalysisResult[],
  crossPatterns: CrossSessionPattern[],
): void {
  const allInsights = results.flatMap((r) => r.insights);
  if (allInsights.length === 0 && crossPatterns.length === 0) {
    console.log(secondary('No insights found across analyzed sessions.'));
    console.log();
    return;
  }

  // Group insights by category
  const byCategory = new Map<InsightCategory, Insight[]>();
  for (const insight of allInsights) {
    const existing = byCategory.get(insight.category) ?? [];
    existing.push(insight);
    byCategory.set(insight.category, existing);
  }

  const categories = [...byCategory.entries()];
  const hasCross = crossPatterns.length > 0;

  for (let ci = 0; ci < categories.length; ci++) {
    const [category, insights] = categories[ci];
    printCategoryBlock(category, insights, ci === categories.length - 1 && !hasCross);
  }

  // Cross-session patterns
  if (hasCross) {
    printCrossPatternsBlock(crossPatterns);
  }

  // Summary
  const totalAnalysisTime = results.reduce((sum, r) => sum + r.stats.analysisTimeMs, 0);
  const sessionsWithInsights = results.filter((r) => r.insights.length > 0).length;

  console.log(step('Summary'));
  console.log(
    substep(`${color.bold(String(allInsights.length))} insights from ${sessionsWithInsights}/${results.length} sessions` +
    (crossPatterns.length > 0 ? `, ${color.bold(String(crossPatterns.length))} cross-session patterns` : '')),
  );
  console.log(lastSub(secondary(`Analysis time: ${(totalAnalysisTime / 1000).toFixed(1)}s total`)));
  console.log();
}

function printCategoryBlock(category: InsightCategory, insights: Insight[], _isLastCategory: boolean): void {
  const label = CATEGORY_LABELS[category];
  console.log(step(`${label} (${insights.length})`));

  for (let i = 0; i < insights.length; i++) {
    printInsight(insights[i], i === insights.length - 1);
  }
  console.log();
}

function printInsight(insight: Insight, isLast: boolean): void {
  const confPct = Math.round(insight.confidence * 100);
  const pLabel = priorityLabel(confPct >= 80 ? 'high' : confPct >= 60 ? 'medium' : 'low');
  const connector = isLast ? lastSub : substep;

  console.log(connector(`${pLabel}  ${color.bold(String(confPct) + '%')}  ${insight.title}`));
  console.log(treeCont(secondary(insight.description)));

  if (insight.evidence.length > 0) {
    for (const ev of insight.evidence) {
      const roleTag = ev.role === 'user' ? '[USER]' : '[ASST]';
      const text = ev.text.length > 80 ? ev.text.slice(0, 77) + '...' : ev.text;
      console.log(treeCont(tertiary(`${roleTag} "${text}"`)));
    }
  }

  if (insight.suggestedRule) {
    console.log(treeCont(`${icon.arrow} ${insight.suggestedRule}`));
  }
}

function printCrossPatternsBlock(patterns: CrossSessionPattern[]): void {
  console.log(step(`Cross-session patterns (${patterns.length})`));

  for (let i = 0; i < patterns.length; i++) {
    printCrossPattern(patterns[i], i === patterns.length - 1);
  }
  console.log();
}

function printCrossPattern(pattern: CrossSessionPattern, isLast: boolean): void {
  const confPct = Math.round(pattern.confidence * 100);
  const sessionCount = pattern.occurrences.length;
  const connector = isLast ? lastSub : substep;

  console.log(connector(`${color.bold(String(confPct) + '%')}  ${pattern.title} ${secondary(`(${sessionCount} sessions)`)}`));
  console.log(treeCont(secondary(pattern.description)));

  if (pattern.suggestedRule) {
    console.log(treeCont(`${icon.arrow} ${pattern.suggestedRule}`));
  }
}

export function printAnalysisSummaryLine(
  toAnalyze: number,
  alreadyAnalyzed: number,
  projectPath: string,
): void {
  const skipMsg = alreadyAnalyzed > 0 ? secondary(` (${alreadyAnalyzed} already analyzed, skipped)`) : '';
  console.log(substep(`Project: ${shortPath(projectPath)}`));
  console.log(substep(`Sessions to analyze: ${color.bold(String(toAnalyze))}${skipMsg}`));
}

export function printDryRun(sessionId: string, userMessages: number, reason: string): void {
  const shortId = sessionId.slice(0, 8);
  console.log(substep(secondary(`[dry-run] Would analyze ${shortId} (${userMessages} user msgs) ${icon.dash} ${reason}`)));
}

export function printNothingToAnalyze(): void {
  console.log(lastSub(secondary('Nothing new to analyze. Run with --force to re-analyze.')));
  console.log();
}

// === Rules Reader output ===

export function printRulesHeader(projectRoot?: string): void {
  for (const line of buildBanner('Rules', projectRoot)) {
    console.log(line);
  }
  console.log();
}

export function printRulesOverview(snapshot: RulesSnapshot): void {
  if (snapshot.files.length === 0) {
    console.log(secondary('No rules files found. This project has no CLAUDE.md or .claude/rules/.'));
    console.log(secondary('Tip: Run "claude /init" in this directory to set up CLAUDE.md.'));
    console.log();
    return;
  }

  // Files
  console.log(step(`Rules files: ${snapshot.files.length}`));
  for (let i = 0; i < snapshot.files.length; i++) {
    const file = snapshot.files[i];
    const name = file.relativePath.padEnd(35);
    const scope = file.scope.padEnd(14);
    const ruleCount = `${file.rules.length} rule${file.rules.length === 1 ? '' : 's'}`.padEnd(10);
    const size = formatFileSize(file.sizeBytes);
    const line = `${filePath(name)} ${tertiary('|')} ${scope} ${tertiary('|')} ${ruleCount} ${tertiary('|')} ${size}`;
    if (i === snapshot.files.length - 1) {
      console.log(lastSub(line));
    } else {
      console.log(substep(line));
    }
  }
  // Large-file warnings (between files and stats)
  const largeFiles = snapshot.files.filter((f) => f.content.split('\n').length > 500);
  if (largeFiles.length > 0) {
    console.log();
    for (const file of largeFiles) {
      const lineCount = file.content.split('\n').length;
      console.log(warn(`${file.relativePath} is very large (${lineCount} lines). Consider splitting into .claude/rules/.`));
    }
  }

  console.log();

  // Stats
  const { stats } = snapshot;
  const statLines: string[] = [];
  statLines.push(`Total rules: ${color.bold(String(stats.totalRules))}`);
  statLines.push(`By scope: ${stats.byScope.global} global, ${stats.byScope.project} project, ${stats.byScope.project_local} local, ${stats.byScope.subdirectory} subdir`);
  statLines.push(`By format: ${stats.byFormat.bullet_point} bullet, ${stats.byFormat.paragraph} paragraph, ${stats.byFormat.command} command, ${stats.byFormat.emphatic} emphatic`);

  if (stats.importCount > 0) {
    const importPaths = snapshot.files
      .flatMap((f) => f.imports)
      .map((imp) => `@${imp.path}`);
    statLines.push(`Imports: ${stats.importCount} (${importPaths.join(', ')})`);
  }

  const emphaticCount = snapshot.allRules.filter((r) => r.emphasis === 'important').length;
  if (emphaticCount > 0) {
    statLines.push(`Emphasis: ${emphaticCount} rules with IMPORTANT/MUST/NEVER`);
  }

  console.log(step('Stats'));
  for (let i = 0; i < statLines.length; i++) {
    if (i === statLines.length - 1) {
      console.log(lastSub(statLines[i]));
    } else {
      console.log(substep(statLines[i]));
    }
  }
  console.log();
}

export function printRulesDetailed(snapshot: RulesSnapshot): void {
  for (const file of snapshot.files) {
    printRulesFileDetail(file);
  }
}

function printRulesFileDetail(file: RulesFile): void {
  console.log(color.bold(`${filePath(file.relativePath)} (${file.scope}, ${file.rules.length} rule${file.rules.length === 1 ? '' : 's'})`));
  console.log();

  if (file.rules.length === 0) {
    console.log(secondary('  (no rules parsed)'));
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
        console.log(color.bold(`  ## ${currentSection} (${sectionRules.length} rules)`));
      }
    }

    const lineRef = tertiary(`[L${rule.lineStart}]`);
    const emphasisTag = rule.emphasis === 'important' ? 'IMPORTANT ' : '';

    const textPreview = rule.text.length > 100
      ? rule.text.slice(0, 97) + '...'
      : rule.text;

    const displayText = textPreview.replace(/\n/g, ' ');

    console.log(`    ${lineRef} ${emphasisTag}"${displayText}"`);
  }

  console.log();
}

export function printRulesFileLargeWarning(path: string, lineCount: number): void {
  console.log(warn(`${path} is very large (${lineCount} lines). Consider splitting into .claude/rules/.`));
}

// === Suggestion Generator output ===

export function printSuggesterHeader(projectRoot?: string): void {
  for (const line of buildBanner('Suggest', projectRoot)) {
    console.log(line);
  }
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
  console.log(step('Generating Suggestions'));
  console.log(substep(`Insights: ${color.bold(String(insightCount))} (${sessionInsightCount} from sessions, ${crossPatternCount} cross-session patterns)`));
  console.log(substep(`Rules: ${color.bold(String(ruleCount))} rules across ${fileCount} file${fileCount === 1 ? '' : 's'}`));
  if (filteredOut > 0) {
    console.log(substep(`Filtered: ${insightCount} insights (${filteredOut} below confidence threshold)`));
  }
}

export function printSuggestionResults(
  set: SuggestionSet,
  skipped: Array<{ title: string; reason: string }>,
): void {
  const { suggestions, stats } = set;

  console.log(step(`Suggestions: ${shortPath(set.projectPath)}`));
  console.log();

  if (suggestions.length === 0) {
    console.log(secondary('No suggestions generated. Rules are up to date.'));
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
    console.log(secondary(`  Skipped (${skipped.length}):`));
    for (const s of skipped) {
      console.log(secondary(`    "${s.title}" ${icon.dash} ${s.reason}`));
    }
    console.log();
  }

  // Summary line
  const typeCounts: string[] = [];
  if (stats.byType.add > 0) typeCounts.push(`${stats.byType.add} add`);
  if (stats.byType.update > 0) typeCounts.push(`${stats.byType.update} update`);
  if (stats.byType.remove > 0) typeCounts.push(`${stats.byType.remove} remove`);
  if (stats.byType.consolidate > 0) typeCounts.push(`${stats.byType.consolidate} consolidate`);

  console.log(step(`Summary: ${stats.total} suggestion${stats.total === 1 ? '' : 's'} (${typeCounts.join(', ')})`));
  if (stats.insightsSkipped > 0) {
    console.log(substep(secondary(`${stats.insightsSkipped} insights skipped (already covered)`)));
  }
  console.log(lastSub(secondary(`Current rules: ${stats.estimatedRulesAfter - stats.total} ${icon.arrow} estimated after: ${stats.estimatedRulesAfter}`)));
  console.log();
}

function printSuggestionFileGroup(file: string, suggestions: Suggestion[]): void {
  console.log(color.bold(`${filePath(file)} (${suggestions.length} change${suggestions.length === 1 ? '' : 's'})`));
  console.log();

  for (const s of suggestions) {
    printSuggestionItem(s);
  }
}

function printSuggestionItem(s: Suggestion): void {
  const confPct = Math.round(s.confidence * 100);
  const pLabel = priorityLabel(s.priority);
  const typeLabel = s.type === 'add' ? 'Add rule' : s.type === 'update' ? 'Update rule' : s.type === 'remove' ? 'Remove rule' : 'Consolidate';

  console.log(`  ${pLabel}  ${color.bold(String(confPct) + '%')}  ${typeLabel}: ${s.title}`);
  console.log(secondary(`                ${s.rationale}`));

  if (s.targetSection) {
    console.log(secondary(`                Section: ## ${s.targetSection}`));
  }

  printSuggestionDiff(s);

  console.log();
}

function printSuggestionDiff(s: Suggestion): void {
  const { diff } = s;

  if (diff.parts && diff.parts.length > 0) {
    for (const part of diff.parts) {
      if (part.removedLines) {
        for (const line of part.removedLines) {
          console.log(`                ${diffRemove(line.content)}`);
        }
      }
      if (part.addedLines) {
        for (const line of part.addedLines) {
          console.log(`                ${diffAdd(line.content)}`);
        }
      }
    }
    return;
  }

  if (diff.removedLines) {
    for (const line of diff.removedLines) {
      console.log(`                ${diffRemove(line.content)}`);
    }
  }

  if (diff.addedLines) {
    for (const line of diff.addedLines) {
      console.log(`                ${diffAdd(line.content)}`);
    }
  }
}

export function printSuggestionGenerating(batchCount?: number): void {
  if (batchCount && batchCount > 1) {
    console.log(substep(`Generating suggestions (${batchCount} batches)...`));
  } else {
    console.log(substep('Generating suggestions...'));
  }
}

export function printSuggestionBatchProgress(batchIdx: number, batchCount: number): void {
  console.log(substep(secondary(`Batch ${batchIdx + 1} of ${batchCount}...`)));
}

export function printSuggestionGenerated(count: number, skippedCount: number, durationSec: number): void {
  if (count > 0) {
    const skippedMsg = skippedCount > 0 ? ` (${skippedCount} skipped ${icon.dash} already covered)` : '';
    console.log(success(`${count} suggestion${count === 1 ? '' : 's'}${skippedMsg}`));
  } else {
    console.log(lastSub(secondary(`No suggestions generated (${durationSec.toFixed(1)}s)`)));
  }
  console.log();
}
