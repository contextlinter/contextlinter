import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  ImportReference,
  ParsedRule,
  RuleEmphasis,
  RuleFormat,
  RuleScope,
  RulesFile,
} from './types.js';
import type { DiscoveredFile } from './discovery.js';

const EMPHASIS_PATTERNS = [
  /\bIMPORTANT\b/i,
  /\bMUST\b/,
  /\bNEVER\b/i,
  /\bDO NOT\b/i,
  /\bDON'T\b/i,
  /\bYOU MUST\b/i,
  /\bREQUIRED\b/i,
  /\bCRITICAL\b/i,
];

const NEGATIVE_PATTERNS = [
  /\bnever\b/i,
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bavoid\b/i,
  /\bdo NOT\b/,
];

const IMPORT_PATTERN = /(?:^|\s)@([\w./-]+\.[\w]+)/g;

const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const BULLET_PATTERN = /^(\s*)[*-]\s+(.+)$/;
const FENCED_CODE_OPEN = /^(`{3,}|~{3,})/;

/**
 * Parse a discovered rules file into a RulesFile with extracted rules.
 */
export async function parseRulesFile(file: DiscoveredFile): Promise<RulesFile> {
  let content: string;
  try {
    content = await readFile(file.path, 'utf-8');
  } catch {
    try {
      const buf = await readFile(file.path);
      content = buf.toString('latin1');
    } catch {
      content = '';
    }
  }

  // Normalize CRLF → LF
  content = content.replace(/\r\n/g, '\n');

  const rules = parseMarkdown(content, file.path, file.scope);
  const imports = extractFileImports(content, file.path);

  return {
    path: file.path,
    scope: file.scope,
    relativePath: file.relativePath,
    content,
    rules,
    imports,
    lastModified: file.lastModified,
    sizeBytes: file.sizeBytes,
  };
}

/**
 * Parse freeform Markdown content into structured rules.
 */
export function parseMarkdown(
  content: string,
  sourceFile: string,
  scope: RuleScope,
): ParsedRule[] {
  const lines = content.split('\n');
  const rules: ParsedRule[] = [];

  // State tracking
  let inCodeBlock = false;
  let codeFence = '';
  const sectionStack: { level: number; title: string }[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // --- Fenced code block tracking ---
    if (inCodeBlock) {
      if (isClosingFence(line, codeFence)) {
        inCodeBlock = false;
        codeFence = '';
      }
      i++;
      continue;
    }

    const fenceMatch = line.match(FENCED_CODE_OPEN);
    if (fenceMatch) {
      inCodeBlock = true;
      codeFence = fenceMatch[1];
      i++;
      continue;
    }

    // --- Skip empty lines, HTML comments, and horizontal rules ---
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('<!--') || /^[-*_]{3,}\s*$/.test(trimmed)) {
      i++;
      continue;
    }

    // --- Headings ---
    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // Pop sections that are at the same level or deeper
      while (sectionStack.length > 0 && sectionStack[sectionStack.length - 1].level >= level) {
        sectionStack.pop();
      }
      sectionStack.push({ level, title });

      i++;
      continue;
    }

    // --- Bullet points ---
    const bulletMatch = line.match(BULLET_PATTERN);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;

      // Only treat top-level bullets as rule starts (indent 0 or consistent first-level)
      if (indent <= 2) {
        const { text, endLine } = collectBulletBlock(lines, i);
        const rule = buildRule(text, sourceFile, scope, sectionStack, i + 1, endLine + 1);
        rules.push(rule);
        i = endLine + 1;
      } else {
        // Deeply nested bullet without a parent — treat as standalone
        const { text, endLine } = collectBulletBlock(lines, i);
        const rule = buildRule(text, sourceFile, scope, sectionStack, i + 1, endLine + 1);
        rules.push(rule);
        i = endLine + 1;
      }
      continue;
    }

    // --- Paragraphs (non-empty, non-heading, non-bullet, non-code-fence lines) ---
    const { text: paraText, endLine: paraEnd } = collectParagraph(lines, i);
    if (paraText.trim()) {
      const rule = buildRule(paraText, sourceFile, scope, sectionStack, i + 1, paraEnd + 1);
      rules.push(rule);
    }
    i = paraEnd + 1;
  }

  return rules;
}

/**
 * Collect a bullet point and its nested sub-bullets into a single text block.
 */
function collectBulletBlock(lines: string[], startIdx: number): { text: string; endLine: number } {
  const startMatch = lines[startIdx].match(BULLET_PATTERN);
  if (!startMatch) return { text: lines[startIdx].trim(), endLine: startIdx };

  const baseIndent = startMatch[1].length;
  const collected = [lines[startIdx].trim()];
  let endLine = startIdx;

  for (let j = startIdx + 1; j < lines.length; j++) {
    const line = lines[j];

    // Empty line ends the bullet block
    if (line.trim() === '') break;

    // Check if it's a heading (ends block)
    if (HEADING_PATTERN.test(line)) break;

    // Check if it's a fenced code block (ends block)
    if (FENCED_CODE_OPEN.test(line)) break;

    // Check if it's a nested bullet or continuation
    const nestedMatch = line.match(BULLET_PATTERN);
    if (nestedMatch) {
      const nestedIndent = nestedMatch[1].length;
      if (nestedIndent > baseIndent) {
        // Nested sub-bullet — include as continuation
        collected.push(line.trim());
        endLine = j;
        continue;
      }
      // Same or less indent — it's a sibling bullet, stop
      break;
    }

    // Continuation line (indented text without bullet marker)
    if (line.startsWith(' ') || line.startsWith('\t')) {
      collected.push(line.trim());
      endLine = j;
      continue;
    }

    // Unindented non-bullet line — stop
    break;
  }

  return { text: collected.join('\n'), endLine };
}

/**
 * Collect a paragraph: consecutive non-empty, non-structural lines.
 */
function collectParagraph(lines: string[], startIdx: number): { text: string; endLine: number } {
  const collected: string[] = [];
  let endLine = startIdx;

  for (let j = startIdx; j < lines.length; j++) {
    const line = lines[j];
    const trimmed = line.trim();

    if (trimmed === '') break;
    if (/^[-*_]{3,}\s*$/.test(trimmed)) break;
    if (HEADING_PATTERN.test(line)) break;
    if (BULLET_PATTERN.test(line)) break;
    if (FENCED_CODE_OPEN.test(line)) break;

    collected.push(trimmed);
    endLine = j;
  }

  return { text: collected.join('\n'), endLine };
}

function buildRule(
  text: string,
  sourceFile: string,
  scope: RuleScope,
  sectionStack: { level: number; title: string }[],
  lineStart: number,
  lineEnd: number,
): ParsedRule {
  const section = sectionStack.length > 0
    ? sectionStack[sectionStack.length - 1].title
    : null;
  const sectionHierarchy = sectionStack.map((s) => s.title);
  const format = detectFormat(text);
  const emphasis = detectEmphasis(text);
  const imports = extractInlineImports(text);
  const id = generateRuleId(text, sourceFile, lineStart);

  // Strip leading bullet marker from the text for cleaner display
  let cleanText = text;
  const leadingBullet = cleanText.match(/^[*-]\s+/);
  if (leadingBullet) {
    cleanText = cleanText.slice(leadingBullet[0].length);
  }

  return {
    id,
    text: cleanText,
    section,
    sectionHierarchy,
    sourceFile,
    sourceScope: scope,
    lineStart,
    lineEnd,
    format,
    emphasis,
    imports,
  };
}

function detectFormat(text: string): RuleFormat {
  // Emphatic: starts with IMPORTANT, MUST, NEVER, etc.
  if (/^(IMPORTANT|CRITICAL|YOU MUST|NEVER)\b/i.test(text.replace(/^[*-]\s+/, ''))) {
    return 'emphatic';
  }

  // Command: contains backtick-wrapped command
  const stripped = text.replace(/^[*-]\s+/, '');
  if (/^`[^`]+`/.test(stripped)) {
    return 'command';
  }

  // Bullet point
  if (/^[*-]\s+/.test(text)) {
    return 'bullet_point';
  }

  // Paragraph (default)
  return 'paragraph';
}

function detectEmphasis(text: string): RuleEmphasis {
  for (const pat of EMPHASIS_PATTERNS) {
    if (pat.test(text)) return 'important';
  }
  for (const pat of NEGATIVE_PATTERNS) {
    if (pat.test(text)) return 'negative';
  }
  return 'normal';
}

/**
 * Extract @path/to/file references from text (not inside backtick spans).
 */
function extractInlineImports(text: string): string[] {
  // Remove backtick spans to avoid matching paths inside code
  const withoutCode = text.replace(/`[^`]+`/g, '');
  const matches: string[] = [];

  let match: RegExpExecArray | null;
  const re = new RegExp(IMPORT_PATTERN.source, 'g');
  while ((match = re.exec(withoutCode)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}

/**
 * Extract all @import references from the full file content.
 */
export function extractFileImports(
  content: string,
  sourceFile: string,
): ImportReference[] {
  const lines = content.split('\n');
  const imports: ImportReference[] = [];

  let inCodeBlock = false;
  let codeFence = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks
    if (inCodeBlock) {
      if (isClosingFence(line, codeFence)) {
        inCodeBlock = false;
        codeFence = '';
      }
      continue;
    }

    const fenceMatch = line.match(FENCED_CODE_OPEN);
    if (fenceMatch) {
      inCodeBlock = true;
      codeFence = fenceMatch[1];
      continue;
    }

    // Remove backtick spans
    const withoutCode = line.replace(/`[^`]+`/g, '');

    let match: RegExpExecArray | null;
    const re = new RegExp(IMPORT_PATTERN.source, 'g');
    while ((match = re.exec(withoutCode)) !== null) {
      const importPath = match[1];
      const dir = dirname(sourceFile);
      const resolved = resolveImportPath(dir, importPath);

      imports.push({
        path: importPath,
        resolvedPath: resolved,
        lineNumber: i + 1,
      });
    }
  }

  return imports;
}

function resolveImportPath(baseDir: string, importPath: string): string | null {
  try {
    return resolve(join(baseDir, importPath));
  } catch {
    return null;
  }
}

function isClosingFence(line: string, openFence: string): boolean {
  const trimmed = line.trim();
  const fenceChar = openFence[0];
  const minLen = openFence.length;

  // Closing fence must use the same character and be at least as long
  if (!trimmed.startsWith(fenceChar)) return false;

  const fenceMatch = trimmed.match(new RegExp(`^(${fenceChar === '`' ? '`' : '~'}{${minLen},})\\s*$`));
  return fenceMatch !== null;
}

function generateRuleId(text: string, sourceFile: string, lineStart: number): string {
  const hash = createHash('sha256');
  hash.update(`${sourceFile}:${lineStart}:${text}`);
  return hash.digest('hex').slice(0, 16);
}
