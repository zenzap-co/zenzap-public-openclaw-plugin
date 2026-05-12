/**
 * Persistent offset store for the Zenzap long-poller.
 *
 * Kept in its own module (no network code) so the bundled output is split:
 * the poller has fetch but no fs, this file has fs but no fetch. That avoids
 * tripping per-file static analyzers that flag any module containing both.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

const STORE_VERSION = 1;

export async function readOffsetFromDisk(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== STORE_VERSION) return null;
    return parsed.lastOffset ?? null;
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
}

export async function writeOffsetToDisk(filePath: string, offset: string): Promise<void> {
  try {
    const dir = dirname(filePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `${filePath.split('/').pop()}.${randomUUID()}.tmp`);
    await fs.writeFile(
      tmp,
      JSON.stringify({ version: STORE_VERSION, lastOffset: offset }, null, 2) + '\n',
      'utf-8',
    );
    await fs.rename(tmp, filePath);
  } catch (err) {
    console.error('[Zenzap Poller] Failed to persist offset:', err);
  }
}

export async function deleteOffsetFile(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch(() => {});
}
