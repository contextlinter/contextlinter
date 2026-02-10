import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Suggestion, SuggestionDiff } from '../suggester/types.js';

export interface WriteResult {
  success: boolean;
  action: 'created' | 'modified';
  filePath: string;
  backupPath: string | null;
  error?: string;
}

const backedUpFiles = new Set<string>();

/**
 * Reset backup tracking between apply sessions.
 */
export function resetBackupTracking(): void {
  backedUpFiles.clear();
}

/**
 * Apply a single suggestion to the filesystem.
 * Creates backup before first modification of each file.
 * Uses atomic writes (temp file + rename).
 * Validates the write after completion.
 */
export async function applySuggestion(
  suggestion: Suggestion,
  projectRoot: string,
  storeDir: string,
  editedContent?: string,
): Promise<WriteResult> {
  const targetPath = resolve(projectRoot, suggestion.targetFile);

  // Check if file exists
  const fileExists = await exists(targetPath);

  if (suggestion.type === 'add' || (suggestion.type === 'consolidate' && !fileExists)) {
    return applyAdd(suggestion, targetPath, projectRoot, storeDir, editedContent);
  }

  if (!fileExists) {
    // For update/remove/consolidate on a non-existent file — create it with the content
    if (suggestion.type === 'update' || suggestion.type === 'consolidate') {
      return applyAdd(suggestion, targetPath, projectRoot, storeDir, editedContent);
    }
    return {
      success: false,
      action: 'modified',
      filePath: targetPath,
      backupPath: null,
      error: `File not found: ${suggestion.targetFile}`,
    };
  }

  if (suggestion.type === 'update') {
    return applyUpdate(suggestion, targetPath, projectRoot, storeDir, editedContent);
  }

  if (suggestion.type === 'remove') {
    return applyRemove(suggestion, targetPath, projectRoot, storeDir);
  }

  if (suggestion.type === 'consolidate') {
    return applyConsolidate(suggestion, targetPath, projectRoot, storeDir, editedContent);
  }

  if (suggestion.type === 'split') {
    return applySplit(suggestion, targetPath, projectRoot, storeDir);
  }

  return {
    success: false,
    action: 'modified',
    filePath: targetPath,
    backupPath: null,
    error: `Unknown suggestion type: ${suggestion.type}`,
  };
}

/**
 * Add new content to a file. Creates the file if it doesn't exist.
 */
async function applyAdd(
  suggestion: Suggestion,
  targetPath: string,
  projectRoot: string,
  storeDir: string,
  editedContent?: string,
): Promise<WriteResult> {
  const fileExists = await exists(targetPath);
  const newContent = editedContent ?? getAddedContent(suggestion.diff);

  if (!newContent) {
    return {
      success: false,
      action: 'created',
      filePath: targetPath,
      backupPath: null,
      error: 'No content to add',
    };
  }

  let backupPath: string | null = null;

  if (fileExists) {
    const existing = await readFile(targetPath, 'utf-8');

    // Skip if content already present (prevents duplication on re-runs
    // or when multiple suggestions add overlapping content)
    if (contentAlreadyPresent(existing, newContent)) {
      return { success: true, action: 'modified', filePath: targetPath, backupPath: null };
    }

    backupPath = await backupFile(targetPath, storeDir);

    // Find where to insert
    let updated: string;
    if (suggestion.targetSection) {
      updated = insertInSection(existing, suggestion.targetSection, newContent);
    } else {
      // Append to end of file
      updated = existing.trimEnd() + '\n\n' + newContent + '\n';
    }

    await atomicWrite(targetPath, updated);
    await validateWrite(targetPath, newContent);

    return { success: true, action: 'modified', filePath: targetPath, backupPath };
  }

  // Create new file
  await mkdir(dirname(targetPath), { recursive: true });
  await atomicWrite(targetPath, newContent + '\n');
  await validateWrite(targetPath, newContent);

  return { success: true, action: 'created', filePath: targetPath, backupPath };
}

/**
 * Update existing content in a file (find & replace).
 */
async function applyUpdate(
  suggestion: Suggestion,
  targetPath: string,
  _projectRoot: string,
  storeDir: string,
  editedContent?: string,
): Promise<WriteResult> {
  const backupPath = await backupFile(targetPath, storeDir);
  const existing = await readFile(targetPath, 'utf-8');

  const oldText = getRemovedContent(suggestion.diff);
  const newText = editedContent ?? getAddedContent(suggestion.diff);

  if (!newText) {
    return {
      success: false,
      action: 'modified',
      filePath: targetPath,
      backupPath,
      error: 'No replacement text',
    };
  }

  // If no removedLines (LLM didn't provide old text), fall back to section append
  if (!oldText) {
    let updated: string;
    if (suggestion.targetSection) {
      updated = insertInSection(existing, suggestion.targetSection, newText);
    } else {
      updated = existing.trimEnd() + '\n\n' + newText + '\n';
    }

    await atomicWrite(targetPath, updated);
    await validateWrite(targetPath, newText);

    return { success: true, action: 'modified', filePath: targetPath, backupPath };
  }

  // Try exact match first, then fuzzy
  let updated = tryReplace(existing, oldText, newText);
  if (updated === null) {
    // Try line-by-line fuzzy match
    updated = tryFuzzyReplace(existing, oldText, newText);
  }

  if (updated === null) {
    return {
      success: false,
      action: 'modified',
      filePath: targetPath,
      backupPath,
      error: `Could not find text to replace in ${basename(targetPath)}. Skipping this suggestion.`,
    };
  }

  await atomicWrite(targetPath, updated);
  await validateWrite(targetPath, newText);

  return { success: true, action: 'modified', filePath: targetPath, backupPath };
}

/**
 * Remove content from a file.
 */
async function applyRemove(
  suggestion: Suggestion,
  targetPath: string,
  _projectRoot: string,
  storeDir: string,
): Promise<WriteResult> {
  const backupPath = await backupFile(targetPath, storeDir);
  const existing = await readFile(targetPath, 'utf-8');

  const oldText = getRemovedContent(suggestion.diff);
  if (!oldText) {
    return {
      success: false,
      action: 'modified',
      filePath: targetPath,
      backupPath,
      error: 'No text to remove',
    };
  }

  let updated = tryReplace(existing, oldText, '');
  if (updated === null) {
    updated = tryFuzzyReplace(existing, oldText, '');
  }

  if (updated === null) {
    return {
      success: false,
      action: 'modified',
      filePath: targetPath,
      backupPath,
      error: `Could not find text to remove in ${basename(targetPath)}. Skipping this suggestion.`,
    };
  }

  // Clean up extra blank lines left by removal
  updated = updated.replace(/\n{3,}/g, '\n\n');

  await atomicWrite(targetPath, updated);

  return { success: true, action: 'modified', filePath: targetPath, backupPath };
}

/**
 * Consolidate: remove old parts, add new consolidated content.
 */
async function applyConsolidate(
  suggestion: Suggestion,
  targetPath: string,
  _projectRoot: string,
  storeDir: string,
  editedContent?: string,
): Promise<WriteResult> {
  const backupPath = await backupFile(targetPath, storeDir);
  let existing = await readFile(targetPath, 'utf-8');

  // Remove old parts
  if (suggestion.diff.parts) {
    for (const part of suggestion.diff.parts) {
      const oldText = getRemovedContentFromDiff(part);
      if (oldText) {
        const result = tryReplace(existing, oldText, '') ?? tryFuzzyReplace(existing, oldText, '');
        if (result !== null) {
          existing = result;
        }
      }
    }
  }

  // Clean up extra blank lines
  existing = existing.replace(/\n{3,}/g, '\n\n');

  // Add new consolidated content
  const newContent = editedContent ?? getAddedContent(suggestion.diff);
  if (newContent) {
    if (suggestion.targetSection) {
      existing = insertInSection(existing, suggestion.targetSection, newContent);
    } else {
      existing = existing.trimEnd() + '\n\n' + newContent + '\n';
    }
  }

  await atomicWrite(targetPath, existing);
  if (newContent) {
    await validateWrite(targetPath, newContent);
  }

  return { success: true, action: 'modified', filePath: targetPath, backupPath };
}

/**
 * Split: extract a section from source file into a new dedicated file.
 * Removes the section from the source and creates a new file with the content.
 */
async function applySplit(
  suggestion: Suggestion,
  targetPath: string,
  projectRoot: string,
  storeDir: string,
): Promise<WriteResult> {
  if (!suggestion.splitTarget) {
    return {
      success: false,
      action: 'modified',
      filePath: targetPath,
      backupPath: null,
      error: 'No split target file specified',
    };
  }

  const sectionName = suggestion.targetSection;
  if (!sectionName) {
    return {
      success: false,
      action: 'modified',
      filePath: targetPath,
      backupPath: null,
      error: 'No section specified for split',
    };
  }

  const backupPath = await backupFile(targetPath, storeDir);
  const existing = await readFile(targetPath, 'utf-8');
  const lines = existing.split('\n');

  // Find the section heading
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

  if (sectionStart === -1) {
    return {
      success: false,
      action: 'modified',
      filePath: targetPath,
      backupPath,
      error: `Section "${sectionName}" not found in ${basename(targetPath)}`,
    };
  }

  // Find end of section (next heading of same or higher level, or EOF)
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})\s/);
    if (headingMatch && headingMatch[1].length <= sectionLevel) {
      sectionEnd = i;
      break;
    }
  }

  // Extract section content
  const sectionLines = lines.slice(sectionStart, sectionEnd);

  // Adjust heading levels: reduce by (sectionLevel - 1) so the section heading becomes #
  let sectionContent: string;
  if (sectionLevel > 1) {
    const reduction = sectionLevel - 1;
    sectionContent = sectionLines
      .map((line) => {
        const hMatch = line.match(/^(#{1,6})\s/);
        if (hMatch) {
          const currentLevel = hMatch[1].length;
          const newLevel = Math.max(1, currentLevel - reduction);
          return '#'.repeat(newLevel) + line.slice(hMatch[1].length);
        }
        return line;
      })
      .join('\n');
  } else {
    sectionContent = sectionLines.join('\n');
  }

  // Remove section from source file
  const before = lines.slice(0, sectionStart);
  const after = lines.slice(sectionEnd);
  let updated = [...before, ...after].join('\n');

  // Clean up extra blank lines left by removal
  updated = updated.replace(/\n{3,}/g, '\n\n');

  await atomicWrite(targetPath, updated);

  // Create the new file with the extracted section
  const newFilePath = resolve(projectRoot, suggestion.splitTarget);
  await mkdir(dirname(newFilePath), { recursive: true });

  const newFileContent = sectionContent.trimEnd() + '\n';
  await atomicWrite(newFilePath, newFileContent);
  await validateWrite(newFilePath, sectionName);

  return { success: true, action: 'modified', filePath: targetPath, backupPath };
}

// === Helpers ===

/**
 * Extract the "added" content from a diff as a single string.
 */
function getAddedContent(diff: SuggestionDiff): string | null {
  if (diff.addedLines && diff.addedLines.length > 0) {
    return diff.addedLines.map((l) => l.content).join('\n');
  }
  // Check parts for consolidate
  if (diff.parts) {
    const added: string[] = [];
    for (const part of diff.parts) {
      if (part.addedLines) {
        added.push(...part.addedLines.map((l) => l.content));
      }
    }
    if (added.length > 0) return added.join('\n');
  }
  return null;
}

/**
 * Extract the "removed" content from a diff as a single string.
 */
function getRemovedContent(diff: SuggestionDiff): string | null {
  return getRemovedContentFromDiff(diff);
}

function getRemovedContentFromDiff(diff: SuggestionDiff): string | null {
  if (diff.removedLines && diff.removedLines.length > 0) {
    return diff.removedLines.map((l) => l.content).join('\n');
  }
  return null;
}

/**
 * Try exact string replacement. Returns null if oldText not found.
 */
function tryReplace(content: string, oldText: string, newText: string): string | null {
  if (content.includes(oldText)) {
    return content.replace(oldText, newText);
  }
  return null;
}

/**
 * Try fuzzy replacement by normalizing whitespace.
 * Matches lines after trimming and collapsing whitespace.
 */
function tryFuzzyReplace(content: string, oldText: string, newText: string): string | null {
  const contentLines = content.split('\n');
  const oldLines = oldText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  if (oldLines.length === 0) return null;

  // Find the first line match
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let matches = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normalize(contentLines[i + j]) !== normalize(oldLines[j])) {
        matches = false;
        break;
      }
    }

    if (matches) {
      const before = contentLines.slice(0, i);
      const after = contentLines.slice(i + oldLines.length);
      if (newText === '') {
        return [...before, ...after].join('\n');
      }
      return [...before, newText, ...after].join('\n');
    }
  }

  return null;
}

function normalize(line: string): string {
  return line.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Check if the meaningful lines of newContent already exist in the file.
 * Uses normalized comparison to tolerate whitespace differences.
 */
function contentAlreadyPresent(existing: string, newContent: string): boolean {
  const newLines = newContent.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (newLines.length === 0) return false;

  const existingLines = existing.split('\n').map((l) => l.trim());

  // Check if ALL meaningful lines of newContent exist in the file
  let matchCount = 0;
  for (const newLine of newLines) {
    const normalized = normalize(newLine);
    if (existingLines.some((el) => normalize(el) === normalized)) {
      matchCount++;
    }
  }

  // If >80% of lines match, consider it already present
  return matchCount / newLines.length > 0.8;
}

/**
 * Insert content at the end of a section (before the next heading of same or higher level).
 * If the section doesn't exist, append a new section at the end of the file.
 */
function insertInSection(content: string, sectionName: string, newContent: string): string {
  const lines = content.split('\n');

  // Find the section heading
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

  if (sectionStart === -1) {
    // Section not found — append new section at end
    return content.trimEnd() + '\n\n## ' + sectionName + '\n\n' + newContent + '\n';
  }

  // Find the end of this section (next heading of same or higher level)
  let insertAt = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,6})\s/);
    if (headingMatch && headingMatch[1].length <= sectionLevel) {
      insertAt = i;
      break;
    }
  }

  // Insert before the next heading, with a blank line
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);

  // Trim trailing blank lines from before, then add content
  while (before.length > 0 && before[before.length - 1].trim() === '') {
    before.pop();
  }

  return [...before, '', newContent, '', ...after].join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Backup a file before modifying it. Only backs up once per file per session.
 */
async function backupFile(filePath: string, storeDir: string): Promise<string> {
  if (backedUpFiles.has(filePath)) {
    // Already backed up in this session
    return getBackupPath(filePath, storeDir);
  }

  const backupPath = getBackupPath(filePath, storeDir);
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(filePath, backupPath);
  backedUpFiles.add(filePath);

  return backupPath;
}

function getBackupPath(filePath: string, storeDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = basename(filePath);
  return join(storeDir, 'backups', `${name}.${timestamp}`);
}

/**
 * Atomically write a file using temp file + rename.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  await writeFile(tempPath, content, 'utf-8');
  await rename(tempPath, filePath);
}

/**
 * Validate that a write succeeded by reading back and checking content is present.
 */
async function validateWrite(filePath: string, expectedContent: string): Promise<void> {
  const actual = await readFile(filePath, 'utf-8');
  // Check that the first meaningful line of expected content exists in the file
  const firstLine = expectedContent.split('\n').find((l) => l.trim().length > 0);
  if (firstLine && !actual.includes(firstLine.trim())) {
    throw new Error(`Validation failed: written content not found in ${filePath}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the content that will be written for a suggestion (for display purposes).
 */
export function getContentPreview(suggestion: Suggestion, editedContent?: string): string {
  if (editedContent) return editedContent;
  return getAddedContent(suggestion.diff) ?? getRemovedContent(suggestion.diff) ?? '';
}

/**
 * Compute relative path from projectRoot for display.
 */
export function relativePath(filePath: string, projectRoot: string): string {
  if (filePath.startsWith(projectRoot)) {
    return filePath.slice(projectRoot.length + 1);
  }
  return filePath;
}
