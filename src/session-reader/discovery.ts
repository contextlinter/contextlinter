import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectInfo, SessionFileInfo } from './types.js';
import {
  decodeProjectPath,
  extractSessionId,
  resolveClaudeProjectsDir,
} from '../utils/paths.js';

const MIN_SESSION_FILE_SIZE = 100;

/**
 * Read the first timestamp from a JSONL session file.
 * Only reads the first few lines to find a timestamp, so it's fast.
 */
async function readFirstTimestamp(filePath: string): Promise<Date | null> {
  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let linesRead = 0;
    for await (const line of rl) {
      linesRead++;
      if (linesRead > 5) break; // Only check first 5 lines

      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.timestamp === 'string') {
          const date = new Date(parsed.timestamp);
          if (!isNaN(date.getTime())) {
            rl.close();
            stream.destroy();
            return date;
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Discover all projects inside the Claude projects directory.
 * Returns an empty array if the directory doesn't exist.
 */
export async function discoverProjects(
  baseDir?: string,
): Promise<ProjectInfo[]> {
  const projectsDir = await resolveClaudeProjectsDir(baseDir);
  if (!projectsDir) return [];

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch {
    return [];
  }

  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    const dirPath = join(projectsDir, entry);
    try {
      const dirStat = await stat(dirPath);
      if (!dirStat.isDirectory()) continue;
    } catch {
      continue;
    }

    const sessions = await discoverSessionsInDir(dirPath);
    projects.push({
      projectPath: decodeProjectPath(entry),
      projectPathEncoded: entry,
      dirPath,
      sessions,
    });
  }

  return projects;
}

/**
 * Discover all JSONL session files in a project directory.
 * Returns sessions sorted by creation timestamp (newest first).
 * The creation timestamp is the first message timestamp in the JSONL file,
 * falling back to file modification time if no timestamp is found.
 * Skips files smaller than 100 bytes.
 */
export async function discoverSessionsInDir(
  dirPath: string,
): Promise<SessionFileInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return [];
  }

  const sessions: SessionFileInfo[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;

    const filePath = join(dirPath, entry);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      if (fileStat.size < MIN_SESSION_FILE_SIZE) continue;

      const createdAt = await readFirstTimestamp(filePath);

      sessions.push({
        sessionId: extractSessionId(entry),
        filePath,
        fileSize: fileStat.size,
        modifiedAt: fileStat.mtime,
        createdAt,
      });
    } catch {
      continue;
    }
  }

  // Sort by creation timestamp (newest first), falling back to mtime
  sessions.sort((a, b) => {
    const aTime = (a.createdAt ?? a.modifiedAt).getTime();
    const bTime = (b.createdAt ?? b.modifiedAt).getTime();
    return bTime - aTime;
  });
  return sessions;
}

/**
 * Filter projects to match a specific project path.
 */
export function filterByProject(
  projects: ProjectInfo[],
  projectPath: string,
): ProjectInfo[] {
  const normalized = projectPath.replace(/\/+$/, '');
  return projects.filter(
    (p) =>
      p.projectPath === normalized ||
      p.projectPath === normalized + '/' ||
      p.projectPathEncoded === normalized,
  );
}

/**
 * Find a specific session by ID across all projects.
 */
export function findSessionById(
  projects: ProjectInfo[],
  sessionId: string,
): { project: ProjectInfo; session: SessionFileInfo } | null {
  for (const project of projects) {
    const session = project.sessions.find(
      (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId),
    );
    if (session) return { project, session };
  }
  return null;
}

/**
 * Filter sessions to only include those from the last N days.
 */
export function filterByDays(
  projects: ProjectInfo[],
  days: number,
): ProjectInfo[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return projects
    .map((p) => ({
      ...p,
      sessions: p.sessions.filter((s) => s.modifiedAt >= cutoff),
    }))
    .filter((p) => p.sessions.length > 0);
}

/**
 * Limit each project to the N newest sessions.
 */
export function limitSessions(
  projects: ProjectInfo[],
  limit: number,
): ProjectInfo[] {
  return projects.map((p) => ({
    ...p,
    sessions: p.sessions.slice(0, limit),
  }));
}
