import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { LlmCallResult } from './types.js';

const CLI_TIMEOUT_MS = 120_000;
export const SUGGEST_TIMEOUT_MS = 300_000;
const SANDBOX_DIR = join(tmpdir(), 'contextlinter');
const PROMPT_DIR = join(import.meta.dirname, '..', '..', 'prompts');

export type ModelName = 'opus' | 'sonnet' | 'haiku';

const MODEL_MAP: Record<ModelName, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-5-20250929',
  haiku: 'claude-haiku-4-5-20251001',
};

const DEFAULT_MODEL: ModelName = 'sonnet';

/**
 * Check if the `claude` CLI is available in PATH.
 */
export async function checkCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', ['claude'], (error) => {
      resolve(!error);
    });
  });
}

/**
 * Load a prompt template from the prompts/ directory.
 */
export async function loadPromptTemplate(name: string): Promise<string> {
  const path = join(PROMPT_DIR, `${name}.md`);
  return readFile(path, 'utf-8');
}

/**
 * Get a hash of the prompt template content (for cache invalidation).
 */
export async function getPromptVersion(name: string): Promise<string> {
  const content = await loadPromptTemplate(name);
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * Fill template placeholders: {{key}} → value
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Call Claude CLI with a prompt piped via stdin.
 * Uses spawn + stdin to avoid OS argument length limits.
 */
export async function callClaude(prompt: string, model?: ModelName, timeoutMs?: number): Promise<LlmCallResult> {
  const startTime = Date.now();
  const modelId = MODEL_MAP[model ?? DEFAULT_MODEL];
  const timeout = timeoutMs ?? CLI_TIMEOUT_MS;

  // Run from a sandboxed temp dir so claude -p sessions don't pollute
  // the user's real project session history in ~/.claude/projects/.
  if (!existsSync(SANDBOX_DIR)) {
    mkdirSync(SANDBOX_DIR, { recursive: true });
  }

  const raw = await new Promise<string>((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', modelId, '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: SANDBOX_DIR,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}${stderr ? ` — ${stderr}` : ''}`));
        return;
      }
      resolve(stdout);
    });

    // Timeout handling
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude CLI timed out after ${timeout / 1000}s`));
    }, timeout);

    proc.on('close', () => clearTimeout(timer));

    // Pipe prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();
  });

  const durationMs = Date.now() - startTime;
  const parsed = parseCliResponse(raw);
  const estimatedTokens = Math.ceil(prompt.length / 4) + Math.ceil(raw.length / 4);

  return { raw, parsed, durationMs, estimatedTokens };
}

/**
 * Parse the Claude CLI JSON output.
 * The CLI with --output-format json returns a JSON object with a "result" field.
 * The result field contains the actual text response.
 */
export function parseCliResponse(raw: string): unknown {
  const trimmed = raw.trim();

  // Try parsing as CLI JSON output first (has a "result" field)
  try {
    const cliOutput = JSON.parse(trimmed);
    if (cliOutput && typeof cliOutput === 'object' && 'result' in cliOutput) {
      return extractJsonFromText(String(cliOutput.result));
    }
  } catch {
    // Not valid JSON — try other approaches
  }

  // Try extracting JSON directly
  return extractJsonFromText(trimmed);
}

/**
 * Extract a JSON array from text that might contain markdown fences or other wrapping.
 */
export function extractJsonFromText(text: string): unknown {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // Continue to fallback strategies
  }

  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // Continue
    }
  }

  // Try to find a JSON array in the text
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {
      // Give up
    }
  }

  return null;
}
