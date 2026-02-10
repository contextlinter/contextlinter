import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import chalk from 'chalk';
import type { Suggestion } from '../suggester/types.js';
import type { ApplyAction, ApplyOptions, ApplyResult, ApplySession, RulesHistoryEntry } from './types.js';
import { applySuggestion, getContentPreview, resetBackupTracking } from './file-writer.js';
import { appendHistoryEntry, buildHistoryEntry } from './history.js';
import { invalidateRulesCache } from '../store/rules-cache.js';

interface InteractiveContext {
  suggestions: Suggestion[];
  projectRoot: string;
  storeDir: string;
  options: ApplyOptions;
  results: ApplyResult[];
  filesCreated: Set<string>;
  filesModified: Set<string>;
  rulesAdded: number;
  rulesUpdated: number;
  rulesRemoved: number;
  rulesSplit: number;
  aborted: boolean;
}

/**
 * Run the interactive review loop.
 * Presents suggestions one by one, handles user input, applies accepted changes.
 */
export async function runInteractiveReview(
  suggestions: Suggestion[],
  projectRoot: string,
  storeDir: string,
  options: ApplyOptions,
): Promise<ApplySession> {
  const startedAt = new Date().toISOString();
  resetBackupTracking();

  const ctx: InteractiveContext = {
    suggestions,
    projectRoot,
    storeDir,
    options,
    results: [],
    filesCreated: new Set(),
    filesModified: new Set(),
    rulesAdded: 0,
    rulesUpdated: 0,
    rulesRemoved: 0,
    rulesSplit: 0,
    aborted: false,
  };

  const historyPath = join(storeDir, 'history.jsonl');

  if (suggestions.length === 0) {
    printNoSuggestions();
    return buildSession(ctx, startedAt);
  }

  // Non-interactive modes
  if (options.dryRun) {
    printDryRunHeader();
    for (let i = 0; i < suggestions.length; i++) {
      printSuggestionCard(suggestions[i], i, suggestions.length);
    }
    printDryRunFooter(suggestions.length);
    return buildSession(ctx, startedAt);
  }

  if (options.yes) {
    printAutoAcceptHeader();
    for (const suggestion of suggestions) {
      await applyAndRecord(ctx, suggestion, 'accept', historyPath);
    }
    printSummary(ctx);
    return buildSession(ctx, startedAt);
  }

  if (options.minConfidence !== undefined) {
    printMinConfidenceHeader(options.minConfidence);
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      if (s.confidence >= options.minConfidence) {
        printSuggestionCard(s, i, suggestions.length);
        console.log(chalk.dim(`  Auto-accepting (confidence ${Math.round(s.confidence * 100)}% >= ${Math.round(options.minConfidence * 100)}%)`));
        await applyAndRecord(ctx, s, 'accept', historyPath);
      } else {
        printSuggestionCard(s, i, suggestions.length);
        console.log(chalk.dim(`  Skipping (confidence ${Math.round(s.confidence * 100)}% < ${Math.round(options.minConfidence * 100)}%)`));
        ctx.results.push({
          suggestionId: s.id,
          action: 'skip',
          editedContent: null,
          appliedAt: null,
        });
      }
    }
    printSummary(ctx);
    return buildSession(ctx, startedAt);
  }

  // Interactive mode
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Handle Ctrl+C gracefully
  let sigintReceived = false;
  const sigintHandler = () => {
    sigintReceived = true;
    ctx.aborted = true;
    console.log();
    console.log(chalk.yellow('\nInterrupted. Saving accepted changes...'));
    rl.close();
  };
  process.on('SIGINT', sigintHandler);

  printReviewHeader();

  try {
    for (let i = 0; i < suggestions.length; i++) {
      if (sigintReceived) break;

      const suggestion = suggestions[i];
      printSuggestionCard(suggestion, i, suggestions.length);

      const action = await promptAction(rl);
      if (action === 'quit' || sigintReceived) {
        ctx.results.push({
          suggestionId: suggestion.id,
          action: 'quit',
          editedContent: null,
          appliedAt: null,
        });
        break;
      }

      if (action === 'edit') {
        const editedContent = await promptEdit(rl, suggestion);
        if (editedContent !== null) {
          await applyAndRecord(ctx, suggestion, 'accept', historyPath, editedContent);
        } else {
          ctx.results.push({
            suggestionId: suggestion.id,
            action: 'skip',
            editedContent: null,
            appliedAt: null,
          });
        }
      } else if (action === 'accept') {
        await applyAndRecord(ctx, suggestion, 'accept', historyPath);
      } else {
        // reject or skip
        ctx.results.push({
          suggestionId: suggestion.id,
          action,
          editedContent: null,
          appliedAt: null,
        });
      }

      if (i < suggestions.length - 1 && !sigintReceived) {
        console.log();
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    rl.close();
  }

  printSummary(ctx);
  return buildSession(ctx, startedAt);
}

/**
 * Apply a suggestion and record the result.
 */
async function applyAndRecord(
  ctx: InteractiveContext,
  suggestion: Suggestion,
  action: 'accept',
  historyPath: string,
  editedContent?: string,
): Promise<void> {
  const result = await applySuggestion(suggestion, ctx.projectRoot, ctx.storeDir, editedContent);

  if (result.success) {
    if (result.action === 'created') {
      ctx.filesCreated.add(result.filePath);
      console.log(chalk.green(`  \u2713 Created ${suggestion.targetFile}`));
    } else {
      ctx.filesModified.add(result.filePath);
      console.log(chalk.green(`  \u2713 Updated ${suggestion.targetFile}`));
    }

    // Update counters
    if (suggestion.type === 'add') ctx.rulesAdded++;
    else if (suggestion.type === 'update') ctx.rulesUpdated++;
    else if (suggestion.type === 'remove') ctx.rulesRemoved++;
    else if (suggestion.type === 'consolidate') {
      ctx.rulesRemoved++;
      ctx.rulesAdded++;
    } else if (suggestion.type === 'split') {
      ctx.rulesSplit++;
      // The split target file was created by the applier
      if (suggestion.splitTarget) {
        const splitPath = join(ctx.projectRoot, suggestion.splitTarget);
        ctx.filesCreated.add(splitPath);
      }
    }

    // Count individual added lines as rules
    if (suggestion.diff.addedLines) {
      const ruleLines = suggestion.diff.addedLines.filter(
        (l) => l.content.startsWith('- ') || l.content.startsWith('* '),
      );
      if (ruleLines.length > 1) {
        ctx.rulesAdded += ruleLines.length - 1; // -1 because we already counted 1
      }
    }

    // Invalidate rules cache so the next suggest re-parses modified files
    await invalidateRulesCache(ctx.storeDir);

    // Write history entry
    const content = editedContent ?? getContentPreview(suggestion);
    const previousContent = suggestion.diff.removedLines
      ? suggestion.diff.removedLines.map((l) => l.content).join('\n')
      : null;

    const entry = buildHistoryEntry(
      suggestion.type,
      suggestion.targetFile,
      suggestion.targetSection,
      content,
      previousContent,
      suggestion.rationale,
      suggestion.sourceInsightIds,
      suggestion.sourceSessionIds,
      suggestion.confidence,
    );
    await appendHistoryEntry(historyPath, entry);

    ctx.results.push({
      suggestionId: suggestion.id,
      action: 'accept',
      editedContent: editedContent ?? null,
      appliedAt: new Date().toISOString(),
    });
  } else {
    console.log(chalk.yellow(`  Warning: ${result.error}`));
    ctx.results.push({
      suggestionId: suggestion.id,
      action: 'skip',
      editedContent: null,
      appliedAt: null,
    });
  }
}

/**
 * Prompt user for action on current suggestion.
 */
function promptAction(rl: ReturnType<typeof createInterface>): Promise<ApplyAction> {
  return new Promise((resolve) => {
    console.log();
    const prompt = '[a]ccept  [r]eject  [e]dit  [s]kip  [q]uit all';
    process.stdout.write(prompt + '\n> ');

    rl.once('line', (input) => {
      const key = input.trim().toLowerCase();
      switch (key) {
        case 'a': case 'accept': resolve('accept'); break;
        case 'r': case 'reject': resolve('reject'); break;
        case 'e': case 'edit': resolve('edit'); break;
        case 's': case 'skip': resolve('skip'); break;
        case 'q': case 'quit': resolve('quit'); break;
        default:
          console.log('  Invalid choice. Use: a/r/e/s/q');
          resolve(promptAction(rl));
      }
    });

    rl.once('close', () => {
      resolve('quit');
    });
  });
}

/**
 * Prompt user to edit suggestion content inline.
 */
function promptEdit(
  rl: ReturnType<typeof createInterface>,
  suggestion: Suggestion,
): Promise<string | null> {
  return new Promise((resolve) => {
    const currentContent = getContentPreview(suggestion);
    console.log();
    console.log('  Current content:');
    for (const line of currentContent.split('\n')) {
      console.log(chalk.dim(`    ${line}`));
    }
    console.log();
    console.log('  Enter new content (empty line to finish, "cancel" to skip):');
    process.stdout.write('  > ');

    const lines: string[] = [];

    const onLine = (input: string) => {
      if (input.trim().toLowerCase() === 'cancel') {
        rl.removeListener('line', onLine);
        resolve(null);
        return;
      }
      if (input === '' && lines.length > 0) {
        rl.removeListener('line', onLine);
        resolve(lines.join('\n'));
        return;
      }
      lines.push(input);
      process.stdout.write('  > ');
    };

    rl.on('line', onLine);
  });
}

// === Display functions ===

function printReviewHeader(): void {
  console.log();
  console.log(chalk.green('==> ') + chalk.bold('Review Suggestions'));
  console.log();
}

function printSuggestionCard(suggestion: Suggestion, index: number, total: number): void {
  const confPct = Math.round(suggestion.confidence * 100);
  const priorityLabel = formatPriority(suggestion.priority);
  const counter = chalk.green('==> ') + chalk.bold(`Suggestion ${index + 1}/${total}`);

  console.log(`${counter}${' '.repeat(Math.max(1, 40 - `==> Suggestion ${index + 1}/${total}`.length))}${priorityLabel}  ${chalk.bold(String(confPct) + '%')}`);
  console.log();

  const typeLabel = suggestion.type === 'add' ? 'Add rule to'
    : suggestion.type === 'update' ? 'Update rule in'
    : suggestion.type === 'remove' ? 'Remove rule from'
    : suggestion.type === 'split' ? 'Split section from'
    : 'Consolidate rules in';

  const sectionSuffix = suggestion.targetSection
    ? ` \u00A7 "${suggestion.targetSection}"`
    : '';

  const splitSuffix = suggestion.type === 'split' && suggestion.splitTarget
    ? ` \u2192 ${suggestion.splitTarget}`
    : '';

  console.log(`    ${typeLabel} ${suggestion.targetFile}${sectionSuffix}${splitSuffix}`);
  console.log();

  // Show diff content
  printDiffContent(suggestion);

  // Rationale
  console.log(chalk.dim(`    Rationale: ${suggestion.rationale}`));
}

function printDiffContent(suggestion: Suggestion): void {
  const { diff } = suggestion;

  // Split-specific display: summarize what moves where
  if (suggestion.type === 'split' && diff.parts && diff.parts.length > 0) {
    const removePart = diff.parts.find((p) => p.type === 'remove');
    const addPart = diff.parts.find((p) => p.type === 'add');

    if (removePart?.removedLines && removePart.removedLines.length > 0) {
      const firstLine = removePart.removedLines[0];
      const lastLine = removePart.removedLines[removePart.removedLines.length - 1];
      const lineRange = firstLine.lineNumber && lastLine.lineNumber
        ? ` (lines ${firstLine.lineNumber}-${lastLine.lineNumber})`
        : '';
      console.log(chalk.dim(`    Removes from ${suggestion.targetFile}:`));
      console.log(chalk.red(`    - ${firstLine.content}${lineRange}`));
    }

    if (addPart?.addedLines && suggestion.splitTarget) {
      console.log();
      console.log(chalk.dim(`    Creates ${suggestion.splitTarget}:`));
      for (const line of addPart.addedLines) {
        console.log(chalk.green(`    + ${line.content}`));
      }
    }

    console.log();
    return;
  }

  if (diff.parts && diff.parts.length > 0) {
    for (const part of diff.parts) {
      if (part.removedLines) {
        for (const line of part.removedLines) {
          console.log(chalk.red(`    - ${line.content}`));
        }
      }
      if (part.addedLines) {
        for (const line of part.addedLines) {
          console.log(chalk.green(`    + ${line.content}`));
        }
      }
    }
    console.log();
    return;
  }

  if (diff.removedLines) {
    for (const line of diff.removedLines) {
      console.log(chalk.red(`    - ${line.content}`));
    }
  }

  if (diff.addedLines) {
    for (const line of diff.addedLines) {
      console.log(chalk.green(`    + ${line.content}`));
    }
  }

  console.log();
}

function formatPriority(priority: string): string {
  switch (priority) {
    case 'high': return chalk.bold('HIGH');
    case 'medium': return chalk.bold('MED');
    case 'low': return chalk.bold('LOW');
    default: return '';
  }
}

function printNoSuggestions(): void {
  console.log();
  console.log('Your rules are up to date! Nothing to change.');
  console.log();
}

function printDryRunHeader(): void {
  console.log();
  console.log(chalk.yellow('[DRY RUN] Preview only \u2014 no files will be modified'));
  console.log();
}

function printDryRunFooter(count: number): void {
  console.log(chalk.yellow(`[DRY RUN] ${count} suggestion${count === 1 ? '' : 's'} would be applied. Run without --dry-run to apply.`));
  console.log();
}

function printAutoAcceptHeader(): void {
  console.log();
  console.log(chalk.yellow('Auto-accepting all suggestions (--yes)'));
  console.log();
}

function printMinConfidenceHeader(threshold: number): void {
  console.log();
  console.log(chalk.yellow(`Auto-accepting suggestions with confidence >= ${Math.round(threshold * 100)}%`));
  console.log();
}

function printSummary(ctx: InteractiveContext): void {
  const accepted = ctx.results.filter((r) => r.action === 'accept').length;
  const rejected = ctx.results.filter((r) => r.action === 'reject').length;
  const skipped = ctx.results.filter((r) => r.action === 'skip').length;

  console.log();
  console.log(chalk.green('==> ') + chalk.bold('Summary'));
  console.log();

  console.log(`    Accepted: ${chalk.bold(String(accepted))}`);
  console.log(`    Rejected: ${chalk.bold(String(rejected))}`);
  if (skipped > 0) {
    console.log(`    Skipped:  ${chalk.bold(String(skipped))}`);
  }

  if (ctx.filesCreated.size > 0) {
    const files = Array.from(ctx.filesCreated)
      .map((f) => {
        const rel = f.startsWith(ctx.projectRoot) ? f.slice(ctx.projectRoot.length + 1) : f;
        return rel;
      })
      .join(', ');
    console.log(`    Files created: ${ctx.filesCreated.size} (${files})`);
  }

  if (ctx.filesModified.size > 0) {
    const files = Array.from(ctx.filesModified)
      .map((f) => {
        const rel = f.startsWith(ctx.projectRoot) ? f.slice(ctx.projectRoot.length + 1) : f;
        return rel;
      })
      .join(', ');
    console.log(`    Files modified: ${ctx.filesModified.size} (${files})`);
  }

  if (ctx.rulesAdded > 0) console.log(`    Rules added: ${ctx.rulesAdded}`);
  if (ctx.rulesUpdated > 0) console.log(`    Rules updated: ${ctx.rulesUpdated}`);
  if (ctx.rulesRemoved > 0) console.log(`    Rules removed: ${ctx.rulesRemoved}`);
  if (ctx.rulesSplit > 0) console.log(`    Sections split: ${ctx.rulesSplit}`);

  if (accepted > 0) {
    console.log();
    console.log(chalk.dim(`    History saved to .contextlinter/history.jsonl`));
    console.log();
    console.log(chalk.dim(`    Review changes with: git diff`));
  }

  if (ctx.aborted) {
    console.log();
    console.log(chalk.yellow('  (Review was interrupted. Accepted changes were saved.)'));
  }

  console.log();
}

function buildSession(ctx: InteractiveContext, startedAt: string): ApplySession {
  return {
    startedAt,
    completedAt: new Date().toISOString(),
    projectPath: ctx.projectRoot,
    results: ctx.results,
    filesModified: Array.from(ctx.filesModified),
    filesCreated: Array.from(ctx.filesCreated),
    rulesAdded: ctx.rulesAdded,
    rulesUpdated: ctx.rulesUpdated,
    rulesRemoved: ctx.rulesRemoved,
    rulesSplit: ctx.rulesSplit,
  };
}
