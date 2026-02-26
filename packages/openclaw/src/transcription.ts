import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';

export interface AudioAttachmentLike {
  id?: string;
  name?: string;
  url?: string;
  transcription?: {
    status?: string;
    text?: string;
  };
}

export interface AudioTranscriptionContext {
  topicId: string;
  messageId?: string;
  senderId?: string;
}

export type AudioTranscriber = (
  attachment: AudioAttachmentLike,
  ctx: AudioTranscriptionContext,
) => Promise<string | null>;

export interface WhisperAudioTranscriberOptions {
  enabled?: boolean;
  model?: string;
  language?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

interface RunResult {
  ok: boolean;
  code: number | null;
  notFound: boolean;
  stderr: string;
}

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

function inferExtension(nameOrUrl?: string): string {
  if (!nameOrUrl) return '.audio';
  try {
    const maybeUrl = new URL(nameOrUrl);
    const ext = extname(maybeUrl.pathname || '');
    if (ext && ext.length <= 10) return ext;
  } catch {
    // not a URL, fall through
  }
  const ext = extname(nameOrUrl);
  if (ext && ext.length <= 10) return ext;
  return '.audio';
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        notFound: err?.code === 'ENOENT',
        stderr: err?.message ?? String(err),
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        notFound: false,
        stderr: timedOut ? `${stderr}\ncommand timed out` : stderr,
      });
    });
  });
}

async function fetchAttachmentBytes(url: string, maxBytes: number): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  if (contentLength > 0 && contentLength > maxBytes) {
    throw new Error(`attachment too large (${contentLength} bytes > ${maxBytes})`);
  }

  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > maxBytes) {
    throw new Error(`attachment too large (${body.byteLength} bytes > ${maxBytes})`);
  }

  return body;
}

async function readTranscriptionText(outputDir: string): Promise<string | null> {
  const files = await readdir(outputDir);
  const txtFiles = files.filter((f) => f.endsWith('.txt'));
  if (!txtFiles.length) return null;

  let best = '';
  for (const file of txtFiles) {
    const data = await readFile(join(outputDir, file), 'utf8');
    if (data.trim().length > best.trim().length) best = data;
  }

  const cleaned = best.trim();
  return cleaned || null;
}

export function createWhisperAudioTranscriber(
  options: WhisperAudioTranscriberOptions = {},
): AudioTranscriber {
  const enabled = options.enabled ?? true;
  const model = options.model || 'base';
  const language = options.language || 'en';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let warnedMissingBinary = false;

  return async (
    attachment: AudioAttachmentLike,
    ctx: AudioTranscriptionContext,
  ): Promise<string | null> => {
    if (!enabled) return null;
    if (!attachment?.url) return null;

    const ext = inferExtension(attachment.name || attachment.url);
    const contextKey = `${ctx.topicId}:${ctx.messageId || attachment.id || 'audio'}`;
    const trace = createHash('sha1').update(contextKey).digest('hex').slice(0, 8);

    const workDir = await mkdtemp(join(tmpdir(), 'zenzap-whisper-'));
    const inputPath = join(workDir, `input${ext}`);
    try {
      const bytes = await fetchAttachmentBytes(attachment.url, maxBytes);
      await writeFile(inputPath, bytes);

      const baseArgs = [
        inputPath,
        '--model',
        model,
        '--task',
        'transcribe',
        '--output_format',
        'txt',
        '--output_dir',
        workDir,
        '--language',
        language,
      ];

      const candidates: Array<{ command: string; args: string[] }> = [
        { command: 'whisper', args: baseArgs },
        { command: 'python3', args: ['-m', 'whisper', ...baseArgs] },
      ];

      let lastErr = '';
      for (const candidate of candidates) {
        const result = await runCommand(candidate.command, candidate.args, timeoutMs);
        if (result.notFound) {
          lastErr = `${candidate.command}: command not found`;
          continue;
        }
        if (!result.ok) {
          lastErr = `${candidate.command} exited with code ${result.code}: ${result.stderr.trim()}`;
          continue;
        }

        const transcript = await readTranscriptionText(workDir);
        if (transcript) return transcript;

        lastErr = `${candidate.command}: no transcript file produced`;
      }

      if (!warnedMissingBinary && /command not found/.test(lastErr)) {
        warnedMissingBinary = true;
        console.warn(
          '[Zenzap] Whisper binary not found. Install `whisper` or `python3 -m whisper` to enable local audio transcription.',
        );
      } else if (lastErr) {
        console.warn(`[Zenzap] Whisper transcription failed (${trace}): ${lastErr}`);
      }
      return null;
    } catch (err: any) {
      console.warn(`[Zenzap] Audio transcription error (${trace}): ${err?.message ?? err}`);
      return null;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
