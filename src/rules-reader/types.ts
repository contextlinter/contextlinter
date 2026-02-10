// === Parsed rule ===

export interface ParsedRule {
  id: string;
  text: string;
  section: string | null;
  sectionHierarchy: string[];
  sourceFile: string;
  sourceScope: RuleScope;
  lineStart: number;
  lineEnd: number;
  format: RuleFormat;
  emphasis: RuleEmphasis;
  imports: string[];
}

export type RuleScope =
  | 'global'
  | 'project'
  | 'project_local'
  | 'subdirectory';

export type RuleFormat =
  | 'heading_section'
  | 'bullet_point'
  | 'paragraph'
  | 'command'
  | 'emphatic';

export type RuleEmphasis =
  | 'normal'
  | 'important'
  | 'negative';

// === Rules file ===

export interface RulesFile {
  path: string;
  scope: RuleScope;
  relativePath: string;
  content: string;
  rules: ParsedRule[];
  imports: ImportReference[];
  lastModified: number;
  sizeBytes: number;
}

export interface ImportReference {
  path: string;
  resolvedPath: string | null;
  lineNumber: number;
}

// === Snapshot ===

export interface RulesSnapshot {
  projectRoot: string;
  snapshotAt: string;
  files: RulesFile[];
  allRules: ParsedRule[];
  stats: RulesStats;
}

export interface RulesStats {
  totalFiles: number;
  totalRules: number;
  byScope: Record<RuleScope, number>;
  byFormat: Record<RuleFormat, number>;
  totalLines: number;
  totalSizeBytes: number;
  hasGlobalRules: boolean;
  hasLocalRules: boolean;
  hasModularRules: boolean;
  importCount: number;
}
