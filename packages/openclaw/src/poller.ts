/**
 * Zenzap Long-Polling Handler
 *
 * Persists the Pulsar offset (via ./offset-store.js) so restarts resume from
 * where they left off instead of replaying old messages. Filesystem I/O lives
 * in offset-store on purpose — this module stays network-only so the bundled
 * output never has fs+fetch in the same file.
 */

import { createHmac } from 'crypto';
import { readOffsetFromDisk, writeOffsetToDisk, deleteOffsetFile } from './offset-store.js';

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
        await deleteOffsetFile(this.config.offsetFile);
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
