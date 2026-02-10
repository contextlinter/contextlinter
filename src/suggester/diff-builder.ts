import type { RulesSnapshot, RulesFile } from '../rules-reader/types.js';
import type { LlmSuggestion, SuggestionDiff, DiffLine } from './types.js';

/**
 * Build a SuggestionDiff from the raw LLM suggestion and the rules snapshot.
 * Maps the LLM's textual content to actual line numbers in the target file.
 */
export function buildDiff(
  raw: LlmSuggestion,
  snapshot: RulesSnapshot,
  targetFile: string,
  targetSection: string | null,
): SuggestionDiff | null {
  const file = findTargetFile(snapshot, targetFile);

  if (raw.type === 'split') {
    return buildSplitDiff(raw, file, targetSection);
  }

  if (raw.type === 'consolidate') {
    return buildConsolidateDiff(raw, file);
  }

  if (raw.type === 'remove') {
    return buildRemoveDiff(raw, file);
  }

  if (raw.type === 'update') {
    return buildUpdateDiff(raw, file);
  }

  // Default: add
  return buildAddDiff(raw, file, targetSection);
}

/**
 * Find the matching rules file from the snapshot.
 * Returns null if file doesn't exist yet (new file suggestion).
 */
function findTargetFile(snapshot: RulesSnapshot, targetFile: string): RulesFile | null {
  // Try exact relativePath match first
  const exact = snapshot.files.find((f) => f.relativePath === targetFile);
  if (exact) return exact;

  // Try matching by filename (e.g., "CLAUDE.md" matches "CLAUDE.md" at project root)
  const byName = snapshot.files.find((f) =>
    f.relativePath.endsWith(targetFile) || f.relativePath === targetFile,
  );
  if (byName) return byName;

  // Try matching global rules path
  if (targetFile.includes('~') || targetFile.startsWith('.claude/')) {
    const normalized = targetFile.replace('~/', '').replace('~\\', '');
    return snapshot.files.find((f) => f.path.endsWith(normalized)) ?? null;
  }

  return null;
}

/**
 * Build a diff for adding new content.
 */
function buildAddDiff(
  raw: LlmSuggestion,
  file: RulesFile | null,
  targetSection: string | null,
): SuggestionDiff | null {
  const addText = normalizeToString(raw.content.add);
  if (!addText) return null;

  const addedLines = textToDiffLines(addText);

  // New file — insert at the beginning
  if (!file) {
    return {
      type: 'add',
      afterLine: null,
      inSection: targetSection,
      removedLines: null,
      addedLines,
      parts: null,
    };
  }

  // Find insertion point
  const afterLine = findInsertionPoint(file, targetSection);

  return {
    type: 'add',
    afterLine,
    inSection: targetSection,
    removedLines: null,
    addedLines,
    parts: null,
  };
}

/**
 * Build a diff for updating existing content.
 * Reads the actual section content from the file rather than relying on
 * LLM-provided old text (which is frequently empty or hallucinated).
 */
function buildUpdateDiff(
  raw: LlmSuggestion,
  file: RulesFile | null,
): SuggestionDiff | null {
  const addText = normalizeToString(raw.content.add);
  if (!addText) return null;

  const addedLines = textToDiffLines(addText);

  if (!file) {
    // No file — treat as add to new file
    return {
      type: 'add',
      afterLine: null,
      inSection: raw.targetSection,
      removedLines: null,
      addedLines,
      parts: null,
    };
  }

  // Primary approach: read actual section content from the file
  if (raw.targetSection) {
    const sectionContent = extractSectionContent(file, raw.targetSection);
    if (sectionContent) {
      return {
        type: 'replace',
        afterLine: sectionContent.startLine,
        inSection: raw.targetSection,
        removedLines: sectionContent.lines,
        addedLines,
        parts: null,
      };
    }
  }

  // Fallback: if LLM provided remove text, try to find it in the file
  const removeText = normalizeToString(raw.content.remove);
  if (removeText) {
    const match = findTextInFile(file, removeText);
    const removedLines = match ?? textToDiffLines(removeText);
    const afterLine = match && match.length > 0 ? (match[0].lineNumber ?? null) : null;

    return {
      type: 'replace',
      afterLine,
      inSection: raw.targetSection,
      removedLines,
      addedLines,
      parts: null,
    };
  }

  // No section found and no remove text — treat as add at end of file
  return {
    type: 'add',
    afterLine: totalLines(file),
    inSection: raw.targetSection,
    removedLines: null,
    addedLines,
    parts: null,
  };
}

/**
 * Extract the content of a section from a rules file.
 * Returns the section lines (heading + body) with line numbers.
 */
function extractSectionContent(
  file: RulesFile,
  sectionName: string,
): { startLine: number; lines: DiffLine[] } | null {
  const lines = file.content.split('\n');
  const sectionPattern = new RegExp(`^(#{1,6})\\s+${escapeRegex(sectionName)}\\s*$`, 'i');

  let sectionStart = -1;
  let sectionLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(sectionPattern);
    if (match) {
      sectionStart = i;
      sectionLevel = match[1].length;
      break;
    }
  }

  if (sectionStart === -1) return null;

  // Find end of section (next heading of same or higher level, or EOF)
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})\s/);
    if (headingMatch && headingMatch[1].length <= sectionLevel) {
      sectionEnd = i;
      break;
    }
  }

  // Trim trailing blank lines
  while (sectionEnd > sectionStart + 1 && lines[sectionEnd - 1].trim() === '') {
    sectionEnd--;
  }

  if (sectionEnd <= sectionStart) return null;

  const sectionLines: DiffLine[] = [];
  for (let i = sectionStart; i < sectionEnd; i++) {
    sectionLines.push({ lineNumber: i + 1, content: lines[i] });
  }

  return { startLine: sectionStart + 1, lines: sectionLines };
}

/**
 * Build a diff for removing content.
 */
function buildRemoveDiff(
  raw: LlmSuggestion,
  file: RulesFile | null,
): SuggestionDiff | null {
  const removeText = normalizeToString(raw.content.remove);
  if (!removeText || !file) return null;

  const match = findTextInFile(file, removeText);
  const removedLines = match ?? textToDiffLines(removeText);

  return {
    type: 'remove',
    afterLine: null,
    inSection: null,
    removedLines,
    addedLines: null,
    parts: null,
  };
}

/**
 * Build a diff for consolidating multiple rules.
 */
function buildConsolidateDiff(
  raw: LlmSuggestion,
  file: RulesFile | null,
): SuggestionDiff | null {
  const addText = normalizeToString(raw.content.add);
  const removeTexts = normalizeToStringArray(raw.content.remove);

  if (!addText) return null;

  const parts: SuggestionDiff[] = [];

  // Create remove parts for each old rule
  if (file && removeTexts.length > 0) {
    for (const text of removeTexts) {
      const match = findTextInFile(file, text);
      const removedLines = match ?? textToDiffLines(text);
      parts.push({
        type: 'remove',
        afterLine: null,
        inSection: null,
        removedLines,
        addedLines: null,
        parts: null,
      });
    }
  }

  // Create add part for the consolidated rule
  parts.push({
    type: 'add',
    afterLine: file ? findInsertionPoint(file, raw.targetSection) : null,
    inSection: raw.targetSection,
    removedLines: null,
    addedLines: textToDiffLines(addText),
    parts: null,
  });

  return {
    type: 'replace',
    afterLine: null,
    inSection: raw.targetSection,
    removedLines: null,
    addedLines: null,
    parts,
  };
}

/**
 * Build a diff for splitting a section out of a file into a new file.
 * The removedLines show the section being extracted; addedLines show the new file summary.
 */
function buildSplitDiff(
  raw: LlmSuggestion,
  file: RulesFile | null,
  targetSection: string | null,
): SuggestionDiff | null {
  if (!file || !targetSection) return null;

  const splitTarget = normalizeToString(raw.content.add);
  if (!splitTarget) return null;

  const lines = file.content.split('\n');
  const sectionPattern = new RegExp(`^(#{1,6})\\s+${escapeRegex(targetSection)}\\s*$`, 'i');

  let sectionStart = -1;
  let sectionLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(sectionPattern);
    if (match) {
      sectionStart = i;
      sectionLevel = match[1].length;
      break;
    }
  }

  if (sectionStart === -1) return null;

  // Find end of section (next heading of same or higher level, or EOF)
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})\s/);
    if (headingMatch && headingMatch[1].length <= sectionLevel) {
      sectionEnd = i;
      break;
    }
  }

  // Trim trailing blank lines from the section
  while (sectionEnd > sectionStart + 1 && lines[sectionEnd - 1].trim() === '') {
    sectionEnd--;
  }

  // Extract section lines as removedLines
  const removedLines: DiffLine[] = [];
  for (let i = sectionStart; i < sectionEnd; i++) {
    removedLines.push({ lineNumber: i + 1, content: lines[i] });
  }

  // Count rules in this section
  const sectionRules = file.rules.filter((r) => r.section === targetSection);
  const ruleCount = sectionRules.length;

  // Build addedLines as a summary for the new file
  const addedLines: DiffLine[] = [
    { lineNumber: null, content: `# ${targetSection}` },
    { lineNumber: null, content: `(${ruleCount} rules moved)` },
  ];

  return {
    type: 'replace',
    afterLine: sectionStart + 1,
    inSection: targetSection,
    removedLines: null,
    addedLines: null,
    parts: [
      {
        type: 'remove',
        afterLine: null,
        inSection: targetSection,
        removedLines,
        addedLines: null,
        parts: null,
      },
      {
        type: 'add',
        afterLine: null,
        inSection: null,
        removedLines: null,
        addedLines,
        parts: null,
      },
    ],
  };
}

/**
 * Find the best insertion point for new content in a section.
 * Returns the line number to insert after.
 */
function findInsertionPoint(file: RulesFile, section: string | null): number {
  const lines = file.content.split('\n');

  if (!section) {
    // No section specified — insert at end of file
    return lines.length;
  }

  // Find the section heading
  const sectionPattern = new RegExp(`^#{1,6}\\s+${escapeRegex(section)}\\s*$`, 'i');

  for (let i = 0; i < lines.length; i++) {
    if (sectionPattern.test(lines[i])) {
      // Found the section heading — find the end of the section
      // (next heading of same or higher level, or end of file)
      const headingLevel = lines[i].match(/^(#+)/)?.[1].length ?? 1;

      for (let j = i + 1; j < lines.length; j++) {
        const match = lines[j].match(/^(#+)\s/);
        if (match && match[1].length <= headingLevel) {
          // Insert before the next heading, minus empty lines
          let insertAt = j;
          while (insertAt > i + 1 && lines[insertAt - 1].trim() === '') {
            insertAt--;
          }
          return insertAt;
        }
      }

      // Section goes to end of file
      let insertAt = lines.length;
      while (insertAt > i + 1 && lines[insertAt - 1].trim() === '') {
        insertAt--;
      }
      return insertAt;
    }
  }

  // Section not found — insert at end of file
  return lines.length;
}

/**
 * Find text in a file and return matching DiffLines with line numbers.
 * Uses fuzzy matching: finds lines that contain the search text.
 */
function findTextInFile(file: RulesFile, searchText: string): DiffLine[] | null {
  const fileLines = file.content.split('\n');
  const searchLines = searchText.split('\n').map((l) => l.trim()).filter(Boolean);

  if (searchLines.length === 0) return null;

  // Try to find a contiguous block matching the search text
  for (let i = 0; i < fileLines.length; i++) {
    if (lineMatches(fileLines[i], searchLines[0])) {
      // Check if subsequent lines also match
      let allMatch = true;
      for (let j = 1; j < searchLines.length; j++) {
        if (i + j >= fileLines.length || !lineMatches(fileLines[i + j], searchLines[j])) {
          allMatch = false;
          break;
        }
      }

      if (allMatch) {
        return searchLines.map((_, idx) => ({
          lineNumber: i + idx + 1, // 1-based
          content: fileLines[i + idx],
        }));
      }
    }
  }

  // Fallback: find individual lines
  const found: DiffLine[] = [];
  for (const searchLine of searchLines) {
    for (let i = 0; i < fileLines.length; i++) {
      if (lineMatches(fileLines[i], searchLine)) {
        found.push({ lineNumber: i + 1, content: fileLines[i] });
        break;
      }
    }
  }

  return found.length > 0 ? found : null;
}

/**
 * Check if a file line matches a search line (fuzzy: trim + normalize whitespace).
 */
function lineMatches(fileLine: string, searchLine: string): boolean {
  const a = fileLine.trim().replace(/\s+/g, ' ').toLowerCase();
  const b = searchLine.trim().replace(/\s+/g, ' ').toLowerCase();
  if (a === b) return true;
  // Also match if the file line contains the search line (for bullet markers etc.)
  return a.includes(b) || b.includes(a);
}

function textToDiffLines(text: string): DiffLine[] {
  return text.split('\n').map((line) => ({
    lineNumber: null,
    content: line,
  }));
}

function totalLines(file: RulesFile): number {
  return file.content.split('\n').length;
}

function normalizeToString(value: string | string[] | null): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('\n');
  return null;
}

function normalizeToStringArray(value: string | string[] | null): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return [];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
