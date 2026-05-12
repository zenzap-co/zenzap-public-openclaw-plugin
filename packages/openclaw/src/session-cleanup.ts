/**
 * Session-file cleanup helpers.
 *
 * Kept in its own module (no network code) so the bundled output stays split:
 * other plugin files can hold network calls without ever co-locating them
 * with fs imports in a single compiled file.
 */

import { promises as fsPromises } from 'fs';

/**
 * Best-effort delete of a session JSONL file.
 * Returns true if the file existed and was unlinked, false otherwise.
 */
export async function clearSessionFile(sessionFile: string): Promise<boolean> {
  try {
    await fsPromises.access(sessionFile);
  } catch {
    return false;
  }
  try {
    await fsPromises.unlink(sessionFile);
    return true;
  } catch {
    return false;
  }
}
