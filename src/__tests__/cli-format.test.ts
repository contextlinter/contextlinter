import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CLI_PATH = join(import.meta.dirname, '..', '..', 'dist', 'index.js');

describe('--format flag', () => {
  it('rejects --format with non-run commands', async () => {
    try {
      await execFileAsync('node', [CLI_PATH, 'analyze', '--format', 'json'], {
        timeout: 10_000,
      });
      expect.fail('should have exited with error');
    } catch (err: unknown) {
      const { stderr, stdout } = err as { stderr: string; stdout: string };
      const output = stderr + stdout;
      expect(output).toContain('--format is only supported with the "run" command');
    }
  });

  it('rejects --format with suggest command', async () => {
    try {
      await execFileAsync('node', [CLI_PATH, 'suggest', '--format', 'json'], {
        timeout: 10_000,
      });
      expect.fail('should have exited with error');
    } catch (err: unknown) {
      const { stderr, stdout } = err as { stderr: string; stdout: string };
      const output = stderr + stdout;
      expect(output).toContain('--format is only supported with the "run" command');
    }
  });
});

describe('run --format json', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cl-format-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('outputs JSON error when no project root found', async () => {
    try {
      await execFileAsync('node', [CLI_PATH, 'run', '--format', 'json'], {
        cwd: tempDir,
        timeout: 10_000,
      });
      expect.fail('should have exited with error');
    } catch (err: unknown) {
      const { stdout } = err as { stdout: string };
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.version).toBe(1);
      expect(parsed.error).toBeDefined();
      expect(typeof parsed.error).toBe('string');
    }
  });

  it('JSON output contains no ANSI escape codes', async () => {
    try {
      await execFileAsync('node', [CLI_PATH, 'run', '--format', 'json'], {
        cwd: tempDir,
        timeout: 10_000,
      });
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      // ANSI escape codes start with \x1b[
      expect(output).not.toMatch(/\x1b\[/);
    }
  });
});

describe('init command generates correct template', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cl-init-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('generates slash command with run --format json', async () => {
    await execFileAsync('node', [CLI_PATH, 'init'], {
      cwd: tempDir,
      timeout: 10_000,
    });

    const templatePath = join(tempDir, '.claude', 'commands', 'contextlinter.md');
    const content = await readFile(templatePath, 'utf-8');

    expect(content).toContain('npx contextlinter run --format json');
    expect(content).not.toContain('--limit');
    expect(content).not.toContain('suggest --full');
  });
});
