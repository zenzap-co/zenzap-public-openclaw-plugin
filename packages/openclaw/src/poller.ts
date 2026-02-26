/**
 * Zenzap Long-Polling Handler
 *
 * Persists the Pulsar offset to disk (same pattern as Telegram's update-offset-store)
 * so restarts resume from where they left off instead of replaying old messages.
 */

import { createHmac } from 'crypto';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

const STORE_VERSION = 1;

interface PollConfig {
  apiKey: string;
  apiSecret: string;
  apiUrl: string;
  pollTimeout: number;
  offsetFile?: string; // path to persist offset across restarts
}

interface UpdateResponse {
  updates: Array<{
    updateId: string;
    eventType: string;
    createdAt: number;
    data: any;
  }>;
  nextOffset: string;
}

async function readOffsetFromDisk(filePath: string): Promise<string | null> {
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

async function writeOffsetToDisk(filePath: string, offset: string): Promise<void> {
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

export class ZenzapPoller {
  private config: PollConfig;
  private offset: string | null = null;
  private running = false;
  private abortController: AbortController | null = null;

  constructor(config: PollConfig) {
    this.config = config;
  }

  async start(onMessage: (event: any) => Promise<void> | void) {
    this.running = true;

    // Restore offset from disk if available
    if (this.config.offsetFile) {
      const saved = await readOffsetFromDisk(this.config.offsetFile);
      if (saved) {
        this.offset = saved;
        console.log(`[Zenzap Poller] Resuming from saved offset`);
      }
    }

    console.log(
      `[Zenzap Poller] Starting... (offset=${this.offset ?? 'none'}, url=${this.config.apiUrl})`,
    );

    while (this.running) {
      try {
        const result = await this.poll();
        console.log(
          `[Zenzap Poller] Poll returned: ${result.updates.length} update(s), nextOffset=${result.nextOffset ?? 'none'}`,
        );

        if (result.updates.length > 0) {
          console.log(`[Zenzap Poller] Received ${result.updates.length} update(s)`);
          for (const update of result.updates) {
            await onMessage(update);
          }
        }

        // Advance offset and persist to disk
        if (result.nextOffset && result.nextOffset !== this.offset) {
          this.offset = result.nextOffset;
          if (this.config.offsetFile) {
            await writeOffsetToDisk(this.config.offsetFile, this.offset);
          }
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') break;
        console.error(`[Zenzap Poller] Error: ${err?.message ?? err}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async stop() {
    this.running = false;
    this.abortController?.abort();
  }

  private async poll(): Promise<UpdateResponse> {
    const url = new URL(`${this.config.apiUrl}/v2/updates`);
    url.searchParams.set('limit', '50');
    url.searchParams.set('timeout', this.config.pollTimeout.toString());

    if (this.offset) {
      url.searchParams.set('offset', this.offset);
    }

    const pathWithQuery = `/v2/updates?${url.searchParams.toString()}`;
    const timestamp = String(Date.now());

    const signature = createHmac('sha256', this.config.apiSecret)
      .update(`${timestamp}.${pathWithQuery}`)
      .digest('hex');

    this.abortController = new AbortController();
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'X-Signature': signature,
        'X-Timestamp': timestamp,
      },
      signal: this.abortController.signal,
    });

    if (response.status === 401) throw new Error('Unauthorized: Invalid bot token or signature');
    if (response.status === 409) {
      console.warn('[Zenzap Poller] 409 Conflict — saved offset expired, resetting to latest');
      this.offset = null;
      if (this.config.offsetFile) {
        await fs.unlink(this.config.offsetFile).catch(() => {});
      }
      return { updates: [], nextOffset: '' };
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    return response.json() as Promise<UpdateResponse>;
  }
}
