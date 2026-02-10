import { join } from 'node:path';
import type { AuditLog } from '../analyzer/types.js';
import { readJson, writeJson } from './persistence.js';

const AUDIT_VERSION = 1;

function getAuditPath(storeDir: string): string {
  return join(storeDir, 'audit.json');
}

function createEmptyAuditLog(): AuditLog {
  return {
    sessions: {},
    lastCrossSessionAt: null,
    version: AUDIT_VERSION,
  };
}

export async function loadAuditLog(storeDir: string): Promise<AuditLog> {
  const existing = await readJson<AuditLog>(getAuditPath(storeDir));
  if (!existing || existing.version !== AUDIT_VERSION) {
    return createEmptyAuditLog();
  }
  return existing;
}

export async function saveAuditLog(storeDir: string, audit: AuditLog): Promise<void> {
  await writeJson(getAuditPath(storeDir), audit);
}

export function markSessionParsed(
  audit: AuditLog,
  sessionId: string,
  sessionMtime: number,
): AuditLog {
  const existing = audit.sessions[sessionId];
  return {
    ...audit,
    sessions: {
      ...audit.sessions,
      [sessionId]: {
        parsedAt: new Date().toISOString(),
        analyzedAt: existing?.analyzedAt ?? null,
        analysisPromptVersion: existing?.analysisPromptVersion ?? '',
        insightCount: existing?.insightCount ?? 0,
        sessionMtime,
      },
    },
  };
}

export function markSessionAnalyzed(
  audit: AuditLog,
  sessionId: string,
  promptVersion: string,
  insightCount: number,
): AuditLog {
  const existing = audit.sessions[sessionId];
  if (!existing) return audit;

  return {
    ...audit,
    sessions: {
      ...audit.sessions,
      [sessionId]: {
        ...existing,
        analyzedAt: new Date().toISOString(),
        analysisPromptVersion: promptVersion,
        insightCount,
      },
    },
  };
}

export function markCrossSessionDone(audit: AuditLog): AuditLog {
  return {
    ...audit,
    lastCrossSessionAt: new Date().toISOString(),
  };
}

/**
 * Check if a session needs re-analysis (prompt changed or never analyzed).
 */
export function needsAnalysis(
  audit: AuditLog,
  sessionId: string,
  currentPromptVersion: string,
  currentMtime: number,
): boolean {
  const entry = audit.sessions[sessionId];
  if (!entry) return true;
  if (!entry.analyzedAt) return true;
  if (entry.analysisPromptVersion !== currentPromptVersion) return true;
  if (entry.sessionMtime !== currentMtime) return true;
  return false;
}
