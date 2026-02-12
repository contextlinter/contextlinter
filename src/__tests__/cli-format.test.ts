import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CLI_PATH = join(import.meta.dirname, '..', 'index.ts');
const TSX_PATH = join(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'tsx');

describe('init command generates correct template', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cl-init-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('generates apply-only slash command template', async () => {
    await writeFile(join(tempDir, 'CLAUDE.md'), '');
    await execFileAsync(TSX_PATH, [CLI_PATH, 'init'], {
      cwd: tempDir,
      timeout: 10_000,
    });

    const templatePath = join(tempDir, '.claude', 'commands', 'contextlinter.md');
    const content = await readFile(templatePath, 'utf-8');

    expect(content).toContain('npx contextlinter analyze');
    expect(content).toContain('suggestions');
    expect(content).toContain('.contextlinter/suggestions');
    expect(content).toContain('Accept');
    expect(content).toContain('git diff');
    // Should NOT contain old polling/NDJSON patterns
    expect(content).not.toContain('--format json');
    expect(content).not.toContain('NDJSON');
    expect(content).not.toContain('/tmp/contextlinter-run');
    expect(content).not.toContain('poll');
  });
});
