/**
 * Zenzap API Client
 *
 * Docs: https://docs.zenzap.co/api-reference/getting-started
 * Full spec: https://docs.zenzap.co/llms-full.txt
 *
 * Auth: Bearer token + HMAC-SHA256 signature with replay protection timestamp
 *   - GET requests: sign "{timestamp}.{path+query}"
 *   - POST/PATCH/DELETE: sign "{timestamp}.{json body}"
 *   - Include X-Timestamp header (Unix milliseconds)
 *
 * Known doc/API discrepancies (verify on updates):
 *   - Send message body field: docs say "message", actual API uses "text"
 *   - Add/remove members field: docs say "members", actual API uses "memberIds"
 *   - getCurrentMember path: docs say /v2/members/current, actual API uses /v2/members/me
 */

import { createHmac } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import type {
  ZenzapConfig,
  ZenzapTopic,
  ZenzapMember,
  ZenzapMessage,
  ZenzapTask,
  ZenzapTopicMessagesResponse,
  ZenzapMembersListResponse,
  ZenzapTopicsListResponse,
  ZenzapTasksListResponse,
} from './types';

export class ZenzapClient {
  private config: ZenzapConfig;
  private static readonly MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
  private static readonly DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;

  constructor(config: ZenzapConfig) {
    this.config = config;
  }

  /** GET /v2/members/me */
  async getCurrentMember(): Promise<ZenzapMember> {
    return this.request('GET', '/v2/members/me');
  }

  /** GET /v2/members/:memberId */
  async getMember(memberId: string): Promise<ZenzapMember> {
    return this.request('GET', `/v2/members/${memberId}`);
  }

  /** GET /v2/members */
  async listMembers(options?: {
    limit?: number;
    cursor?: string;
    emails?: string[] | string;
    email?: string; // deprecated alias kept for compatibility
  }): Promise<ZenzapMembersListResponse> {
    let emailsParam: string | undefined;
    if (Array.isArray(options?.emails)) {
      const cleaned = options.emails.map((e) => String(e).trim()).filter(Boolean);
      if (cleaned.length) emailsParam = cleaned.join(',');
    } else if (typeof options?.emails === 'string' && options.emails.trim()) {
      emailsParam = options.emails.trim();
    } else if (typeof options?.email === 'string' && options.email.trim()) {
      emailsParam = options.email.trim();
    }

    return this.request('GET', this.buildPath('/v2/members', {
      limit: options?.limit,
      cursor: options?.cursor,
      emails: emailsParam,
    }));
  }

  /** GET /v2/topics */
  async listTopics(options?: { limit?: number; cursor?: string }): Promise<ZenzapTopicsListResponse> {
    return this.request('GET', this.buildPath('/v2/topics', options));
  }

  /** GET /v2/topics/:topicId */
  async getTopicDetails(topicId: string): Promise<ZenzapTopic> {
    return this.request('GET', `/v2/topics/${topicId}`);
  }

  /** GET /v2/topics/external/:externalId */
  async getTopicByExternalId(externalId: string): Promise<ZenzapTopic> {
    return this.request('GET', `/v2/topics/external/${externalId}`);
  }

  /** POST /v2/topics */
  async createTopic(options: {
    name: string;
    members: string[];
    description?: string;
    externalId?: string;
  }): Promise<ZenzapTopic> {
    return this.request('POST', '/v2/topics', {
      name: options.name,
      members: options.members,
      ...(options.description && { description: options.description }),
      ...(options.externalId && { externalId: options.externalId }),
    });
  }

  /** PATCH /v2/topics/:topicId */
  async updateTopic(
    topicId: string,
    options: { name?: string; description?: string },
  ): Promise<ZenzapTopic> {
    return this.request('PATCH', `/v2/topics/${topicId}`, options);
  }

  /** POST /v2/topics/:topicId/members */
  async addMembersToTopic(topicId: string, members: string[]): Promise<ZenzapTopic> {
    return this.request('POST', `/v2/topics/${topicId}/members`, { memberIds: members });
  }

  /** DELETE /v2/topics/:topicId/members */
  async removeMembersFromTopic(topicId: string, members: string[]): Promise<ZenzapTopic> {
    return this.request('DELETE', `/v2/topics/${topicId}/members`, { memberIds: members });
  }

  /** POST /v2/messages — note: API uses "text" field, not "message" as per docs */
  async sendMessage(options: { topicId: string; text: string }): Promise<ZenzapMessage> {
    return this.request('POST', '/v2/messages', {
      topicId: options.topicId,
      text: options.text,
    });
  }

  /**
   * POST /v2/messages (multipart/form-data)
   * Send an image/file message by uploading bytes from a remote URL or base64.
   */
  async sendImageMessage(options: {
    topicId: string;
    imageUrl?: string;
    imageBase64?: string;
    mimeType?: string;
    caption?: string;
    externalId?: string;
    fileName?: string;
  }): Promise<ZenzapMessage | { ok: true }> {
    const hasImageUrl = typeof options.imageUrl === 'string' && options.imageUrl.trim().length > 0;
    const hasImageBase64 = typeof options.imageBase64 === 'string' && options.imageBase64.trim().length > 0;

    if (hasImageUrl === hasImageBase64) {
      throw new Error('Provide exactly one of imageUrl or imageBase64.');
    }

    const file = hasImageUrl
      ? await this.downloadRemoteFile(
          options.imageUrl as string,
          options.fileName,
          'image',
          ZenzapClient.MAX_UPLOAD_BYTES,
        )
      : this.decodeBase64File(
          options.imageBase64 as string,
          options.fileName,
          options.mimeType,
          'image',
          ZenzapClient.MAX_UPLOAD_BYTES,
        );

    const metaPart = {
      channelID: options.topicId,
      ...(options.caption !== undefined && { caption: options.caption }),
      ...(options.externalId && { externalId: options.externalId }),
    };

    return this.requestMultipart('/v2/messages', metaPart, file);
  }

  /** POST /v2/messages/:messageId/reactions */
  async addReaction(messageId: string, reaction: string): Promise<void> {
    await this.request('POST', `/v2/messages/${messageId}/reactions`, { reaction });
  }

  /** POST /v2/messages/:messageId/read — no body */
  async markMessageRead(messageId: string): Promise<void> {
    await this.request('POST', `/v2/messages/${messageId}/read`);
  }

  /**
   * GET /v2/topics/:topicId/messages
   * Fetch message history with cursor-based pagination.
   * Use order='asc' to get oldest-first (good for context priming).
   */
  async getTopicMessages(
    topicId: string,
    options?: {
      limit?: number;
      order?: 'asc' | 'desc';
      cursor?: string;
      before?: number;
      after?: number;
      includeSystem?: boolean;
      senderId?: string;
    },
  ): Promise<ZenzapTopicMessagesResponse> {
    const params: Record<string, any> = {};
    if (options?.limit) params.limit = options.limit;
    if (options?.order) params.order = options.order;
    if (options?.cursor) params.cursor = options.cursor;
    if (options?.before) params.before = options.before;
    if (options?.after) params.after = options.after;
    if (options?.includeSystem === false) params.includeSystem = 'false';
    if (options?.senderId) params.senderId = options.senderId;
    return this.request('GET', this.buildPath(`/v2/topics/${topicId}/messages`, params));
  }

  /** GET /v2/tasks */
  async listTasks(options?: {
    topicId?: string;
    status?: 'Open' | 'Done';
    assignee?: string; // empty string filters unassigned tasks
    limit?: number;
    cursor?: string;
  }): Promise<ZenzapTasksListResponse> {
    const params: Record<string, any> = {};
    if (options?.topicId) params.topicId = options.topicId;
    if (options?.status) params.status = options.status;
    if (options && Object.prototype.hasOwnProperty.call(options, 'assignee')) {
      params.assignee = options.assignee;
    }
    if (options?.limit) params.limit = options.limit;
    if (options?.cursor) params.cursor = options.cursor;

    return this.request('GET', this.buildPath('/v2/tasks', params));
  }

  /** GET /v2/tasks/:taskId */
  async getTask(taskId: string): Promise<ZenzapTask> {
    return this.request('GET', `/v2/tasks/${taskId}`);
  }

  /** POST /v2/tasks */
  async createTask(options: {
    topicId: string;
    title: string;
    description?: string;
    assignee?: string;
    assignees?: string[];
    dueDate?: number;
    externalId?: string;
  }): Promise<ZenzapTask> {
    const assignee = options.assignee ?? options.assignees?.[0];
    return this.request('POST', '/v2/tasks', {
      topicId: options.topicId,
      title: options.title,
      ...(options.description && { description: options.description }),
      ...(assignee && { assignee }),
      ...(Number.isFinite(options.dueDate) && { dueDate: options.dueDate }),
      ...(options.externalId && { externalId: options.externalId }),
    });
  }

  /** PATCH /v2/tasks/:taskId */
  async updateTask(taskId: string, options: {
    topicId?: string;
    name?: string;
    title?: string;
    description?: string;
    assignee?: string; // empty string unassigns
    dueDate?: number; // set to 0 to clear
    status?: 'Open' | 'Done';
  }): Promise<{ id: string; updatedAt?: number }> {
    return this.request('PATCH', `/v2/tasks/${taskId}`, {
      ...(options.topicId && { topicId: options.topicId }),
      ...(options.name !== undefined && { name: options.name }),
      ...(options.title !== undefined && { title: options.title }),
      ...(options.description !== undefined && { description: options.description }),
      ...(options.assignee !== undefined && { assignee: options.assignee }),
      ...(Number.isFinite(options.dueDate) && { dueDate: options.dueDate }),
      ...(options.status && { status: options.status }),
    });
  }

  private buildPath(base: string, params?: Record<string, any>): string {
    if (!params) return base;
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) p.append(k, String(v));
    }
    return p.toString() ? `${base}?${p.toString()}` : base;
  }

  private inferFileName(urlOrName: string, contentType?: string | null, fallbackBase = 'file'): string {
    try {
      const pathname = new URL(urlOrName).pathname;
      const candidate = decodeURIComponent(pathname.split('/').pop() || '').trim();
      if (candidate) return this.sanitizeFileName(candidate);
    } catch {
      // best-effort fallback below
    }

    const type = (contentType || '').toLowerCase().split(';')[0].trim();
    const extByType: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'image/heif': 'heif',
      'image/svg+xml': 'svg',
    };
    const ext = extByType[type] || 'bin';
    return `${fallbackBase}.${ext}`;
  }

  private sanitizeFileName(fileName: string): string {
    const cleaned = fileName
      .replace(/[\r\n"]/g, '_')
      .replace(/[\\/]/g, '_')
      .trim();
    return cleaned || 'upload.bin';
  }

  private async downloadRemoteFile(
    url: string,
    fileName: string | undefined,
    fallbackBase: string,
    maxBytes: number,
  ): Promise<{ filename: string; contentType: string; bytes: Buffer }> {
    const parsedUrl = this.parseAndValidateDownloadUrl(url);
    await this.assertHostIsPublic(parsedUrl.hostname);

    const timeoutMs = this.resolveDownloadTimeoutMs();
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    try {
      const response = await fetch(parsedUrl.toString(), {
        signal: abortController.signal,
        redirect: 'manual',
      });
      const redirectLocation = response.headers.get('location');
      if (
        (response.status >= 300 && response.status < 400) ||
        redirectLocation
      ) {
        throw new Error('Redirects are not allowed');
      }
      if (!response.ok) {
        throw new Error(`Failed to download file: HTTP ${response.status}`);
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > 0 && contentLength > maxBytes) {
        throw new Error(`File too large: ${contentLength} bytes (max ${maxBytes})`);
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const bytes = await this.readResponseBodyWithLimit(response, maxBytes);

      const resolvedName = this.sanitizeFileName(
        fileName || this.inferFileName(url, contentType, fallbackBase),
      );

      return { filename: resolvedName, contentType, bytes };
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error(`Failed to download file: request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseAndValidateDownloadUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('Invalid imageUrl: expected a valid absolute URL.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Invalid imageUrl: only http/https URLs are allowed.');
    }
    if (!parsed.hostname) {
      throw new Error('Invalid imageUrl: hostname is required.');
    }

    return parsed;
  }

  private resolveDownloadTimeoutMs(): number {
    const configured = this.config.downloadTimeoutMs;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
    return ZenzapClient.DEFAULT_DOWNLOAD_TIMEOUT_MS;
  }

  private async assertHostIsPublic(hostname: string): Promise<void> {
    const normalizedHost = hostname.trim().toLowerCase();
    if (!normalizedHost) {
      throw new Error('Invalid imageUrl: hostname is required.');
    }
    if (normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost')) {
      throw new Error(`Blocked imageUrl host: ${hostname}`);
    }

    const directIpVersion = isIP(normalizedHost);
    if (directIpVersion !== 0) {
      if (this.isPrivateOrLocalIp(normalizedHost, directIpVersion)) {
        throw new Error(`Blocked imageUrl host: ${hostname}`);
      }
      return;
    }

    let resolved: Array<{ address: string; family: number }>;
    try {
      resolved = await lookup(normalizedHost, { all: true, verbatim: true });
    } catch {
      throw new Error(`Failed to resolve imageUrl host: ${hostname}`);
    }
    if (!resolved.length) {
      throw new Error(`Failed to resolve imageUrl host: ${hostname}`);
    }

    for (const record of resolved) {
      if (this.isPrivateOrLocalIp(record.address, record.family)) {
        throw new Error(`Blocked imageUrl host: ${hostname}`);
      }
    }
  }

  private isPrivateOrLocalIp(address: string, family: number): boolean {
    if (family === 4) return this.isPrivateOrLocalIpv4(address);
    if (family === 6) return this.isPrivateOrLocalIpv6(address);
    return true;
  }

  private isPrivateOrLocalIpv4(address: string): boolean {
    const parts = address.split('.');
    if (parts.length !== 4) return true;
    const octets = parts.map((p) => Number(p));
    if (octets.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return true;

    const [a, b, c] = octets;
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark testing
    if (a >= 224) return true; // multicast + reserved

    return false;
  }

  private isPrivateOrLocalIpv6(address: string): boolean {
    let normalized = address.toLowerCase();
    const zoneIndex = normalized.indexOf('%');
    if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);

    if (normalized === '::1' || normalized === '::') return true; // loopback/unspecified
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
    if (/^fe[89ab]/.test(normalized)) return true; // link-local

    const mappedIpv4 = this.extractMappedIpv4FromIpv6(normalized);
    if (mappedIpv4) return this.isPrivateOrLocalIpv4(mappedIpv4);

    return false;
  }

  private extractMappedIpv4FromIpv6(address: string): string | null {
    if (!address.startsWith('::ffff:')) return null;
    const tail = address.slice('::ffff:'.length);
    if (isIP(tail) === 4) return tail;

    const parts = tail.split(':');
    if (parts.length !== 2) return null;
    if (!parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return null;

    const hi = Number.parseInt(parts[0], 16);
    const lo = Number.parseInt(parts[1], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }

  private async readResponseBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
    if (!response.body) {
      throw new Error('Failed to download file: empty response body.');
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`File too large: ${totalBytes} bytes (max ${maxBytes})`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks, totalBytes);
  }

  private decodeBase64File(
    input: string,
    fileName: string | undefined,
    mimeType: string | undefined,
    fallbackBase: string,
    maxBytes: number,
  ): { filename: string; contentType: string; bytes: Buffer } {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error('imageBase64 is empty.');
    }

    let payload = trimmed;
    let dataUriMimeType: string | undefined;
    const dataUriMatch = /^data:([^;,]+)?;base64,(.+)$/s.exec(trimmed);
    if (dataUriMatch) {
      dataUriMimeType = dataUriMatch[1]?.trim() || undefined;
      payload = dataUriMatch[2];
    }

    let normalized = payload
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    if (!normalized) {
      throw new Error('imageBase64 is empty.');
    }
    if (normalized.length % 4 === 1) {
      throw new Error('imageBase64 is not valid base64.');
    }
    if (normalized.length % 4 !== 0) {
      normalized += '='.repeat(4 - (normalized.length % 4));
    }

    const bytes = Buffer.from(normalized, 'base64');
    if (!bytes.length) {
      throw new Error('imageBase64 decoded to empty content.');
    }
    if (bytes.length > maxBytes) {
      throw new Error(`File too large: ${bytes.length} bytes (max ${maxBytes})`);
    }

    const contentType = mimeType?.trim() || dataUriMimeType || 'application/octet-stream';
    const resolvedName = this.sanitizeFileName(
      fileName || this.inferFileName(fallbackBase, contentType, fallbackBase),
    );

    return { filename: resolvedName, contentType, bytes };
  }

  private buildMultipartBody(
    metaPart: Record<string, any>,
    file: { filename: string; contentType: string; bytes: Buffer },
  ): { body: Buffer; boundary: string } {
    const boundary = `----zenzap-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const chunks: Buffer[] = [];

    const pushText = (text: string) => chunks.push(Buffer.from(text, 'utf8'));
    const metaJson = JSON.stringify(metaPart);

    pushText(`--${boundary}\r\n`);
    pushText(`Content-Disposition: form-data; name="metaPart"\r\n`);
    pushText(`Content-Type: application/json\r\n\r\n`);
    pushText(metaJson);
    pushText(`\r\n`);

    pushText(`--${boundary}\r\n`);
    pushText(
      `Content-Disposition: form-data; name="filePart"; filename="${this.sanitizeFileName(file.filename)}"\r\n`,
    );
    pushText(`Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`);
    chunks.push(file.bytes);
    pushText(`\r\n--${boundary}--\r\n`);

    return {
      body: Buffer.concat(chunks),
      boundary,
    };
  }

  private async requestMultipart<T = any>(
    path: string,
    metaPart: Record<string, any>,
    file: { filename: string; contentType: string; bytes: Buffer },
  ): Promise<T> {
    const url = new URL(path, this.config.apiUrl ?? 'https://api.zenzap.co').toString();
    const { body, boundary } = this.buildMultipartBody(metaPart, file);

    const timestamp = String(Date.now());
    const signature = createHmac('sha256', this.config.apiSecret)
      .update(`${timestamp}.`)
      .update(body)
      .digest('hex');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'X-Signature': signature,
        'X-Timestamp': timestamp,
      },
      body,
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Zenzap API error (${response.status}): ${details}`);
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : { ok: true }) as T;
  }

  private async request<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    body?: any,
    retries = 3,
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this._doRequest<T>(method, path, body);
      } catch (err: any) {
        const isTransient =
          err.message?.includes('fetch failed') ||
          err.message?.includes('ECONNRESET') ||
          err.message?.includes('ETIMEDOUT') ||
          /Zenzap API error \(5\d\d\)/.test(err.message ?? '');
        if (!isTransient || attempt === retries) throw err;
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000); // 1s, 2s, 4s…
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error('unreachable');
  }

  private async _doRequest<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    body?: any,
  ): Promise<T> {
    const url = new URL(path, this.config.apiUrl ?? 'https://api.zenzap.co').toString();
    let bodyStr = '';
    let signaturePayload: string;

    if (method === 'GET') {
      signaturePayload = path;
    } else {
      bodyStr = JSON.stringify(body ?? {}, null, 0);
      signaturePayload = bodyStr;
    }
    const timestamp = String(Date.now());

    const signature = createHmac('sha256', this.config.apiSecret)
      .update(`${timestamp}.${signaturePayload}`)
      .digest('hex');

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Timestamp': timestamp,
      },
      body: bodyStr || undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Zenzap API error (${response.status}): ${text}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

let sharedClient: ZenzapClient | null = null;

export function initializeClient(config: ZenzapConfig): ZenzapClient {
  sharedClient = new ZenzapClient(config);
  return sharedClient;
}

export function getClient(): ZenzapClient {
  if (!sharedClient) {
    throw new Error('Zenzap client not initialized. Call initializeClient() first.');
  }
  return sharedClient;
}
