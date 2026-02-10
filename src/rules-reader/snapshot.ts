import type {
  ParsedRule,
  RuleEmphasis,
  RuleFormat,
  RuleScope,
  RulesFile,
  RulesSnapshot,
  RulesStats,
} from './types.js';
import { discoverRulesFiles } from './discovery.js';
import { parseRulesFile } from './parser.js';

/**
 * Build a complete RulesSnapshot for a project.
 */
export async function buildRulesSnapshot(projectRoot: string): Promise<RulesSnapshot> {
  const discovered = await discoverRulesFiles(projectRoot);

  const files: RulesFile[] = [];
  for (const file of discovered) {
    const parsed = await parseRulesFile(file);
    files.push(parsed);
  }

  const allRules = files.flatMap((f) => f.rules);
  const stats = computeStats(files, allRules);

  return {
    projectRoot,
    snapshotAt: new Date().toISOString(),
    files,
    allRules,
    stats,
  };
}

function computeStats(files: RulesFile[], allRules: ParsedRule[]): RulesStats {
  const byScope: Record<RuleScope, number> = {
    global: 0,
    project: 0,
    project_local: 0,
    subdirectory: 0,
  };

  const byFormat: Record<RuleFormat, number> = {
    heading_section: 0,
    bullet_point: 0,
    paragraph: 0,
    command: 0,
    emphatic: 0,
  };

  for (const rule of allRules) {
    byScope[rule.sourceScope]++;
    byFormat[rule.format]++;
  }

  const totalLines = files.reduce((sum, f) => sum + f.content.split('\n').length, 0);
  const totalSizeBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const importCount = files.reduce((sum, f) => sum + f.imports.length, 0);

  return {
    totalFiles: files.length,
    totalRules: allRules.length,
    byScope,
    byFormat,
    totalLines,
    totalSizeBytes,
    hasGlobalRules: byScope.global > 0,
    hasLocalRules: byScope.project_local > 0,
    hasModularRules: files.some((f) => f.relativePath.startsWith('.claude/rules/')),
    importCount,
  };
}
