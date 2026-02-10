import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Read and parse a JSON file. Returns null if the file doesn't exist or is invalid.
 */
export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Atomically write a JSON file using temp-file + rename.
 * Creates parent directories if they don't exist.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tempPath = join(dir, `.tmp-${randomUUID()}.json`);
  const content = JSON.stringify(data, null, 2) + '\n';

  await writeFile(tempPath, content, 'utf-8');
  await rename(tempPath, filePath);
}

/**
 * Initialize the .contextlinter directory with a .gitignore.
 * Returns the path to the .contextlinter directory.
 */
export async function initStoreDir(projectDir: string): Promise<string> {
  const storeDir = join(projectDir, '.contextlinter');
  await mkdir(join(storeDir, 'cache', 'sessions'), { recursive: true });
  await mkdir(join(storeDir, 'analysis', 'sessions'), { recursive: true });
  await mkdir(join(storeDir, 'analysis', 'cross-session'), { recursive: true });

  const gitignorePath = join(storeDir, '.gitignore');
  try {
    await readFile(gitignorePath, 'utf-8');
  } catch {
    await writeFile(gitignorePath, '*\n', 'utf-8');
  }

  return storeDir;
}
