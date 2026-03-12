/**
 * Zenzap Gateway Listener
 *
 * Multi-topic support:
 * - Discovers all topics via API on startup
 * - Creates conversations for each topic
 * - Routes inbound/outbound by topicId
 * - Mention gating: topics can require @bot mention (configurable)
 * - Handles message.created + message.updated so non-text and voice flows work
 */

import { ZenzapPoller } from './poller.js';
import { ZenzapClient, type ZenzapAttachment } from '@zenzap-co/sdk';
import type { AudioTranscriber } from './transcription.js';

const AUDIO_TRANSCRIPTION_TIMEOUT_MS = 10_000;

class CappedMap<K, V> extends Map<K, V> {
  constructor(private maxSize: number) {
    super();
  }
  set(key: K, value: V): this {
    const isExistingKey = this.has(key);
    if (!isExistingKey && this.size >= this.maxSize) {
      const oldest = this.keys().next().value!;
      this.delete(oldest);
    }
    return super.set(key, value);
  }
}

interface ListenerContext {
  config: {
    apiKey: string;
    apiSecret: string;
    apiUrl: string;
    pollTimeout: number;
    offsetFile?: string;
  };
  botMemberId?: string;
  /** Topic UUID that acts as the admin control channel — always responds, no mention gating */
  controlTopicId?: string;
  client?: ZenzapClient;
  sendMessage?: (message: any) => Promise<void>;
  /** Called when the bot is added to a new topic */
  onBotJoinedTopic?: (topicId: string, topicName: string, memberCount: number) => Promise<void>;
  /** Called when the poller encounters a fatal/repeated error */
  onPollerError?: (err: Error) => Promise<void>;
  requireMention?: (topicId: string, memberCount: number) => boolean;
  /**
   * Optional local transcription fallback (e.g. Whisper) for audio messages when
   * upstream transcription is still pending.
   */
  transcribeAudio?: AudioTranscriber;
  logger?: {
    debug: (msg: string, data?: any) => void;
    info: (msg: string, data?: any) => void;
    error: (msg: string, data?: any) => void;
  };
}

interface TopicInfo {
  id: string;
  name: string;
  conversationId: string;
  memberCount: number;
}

export class ZenzapListener {
  private poller: ZenzapPoller | null = null;
  private running = false;
  private ctx: ListenerContext;
  private topics: Map<string, TopicInfo> = new Map();
  private messageSignatures = new CappedMap<string, string>(5000);
  private audioTranscriptCache = new CappedMap<string, string>(1000);
  private pendingAudioMessages = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(ctx: ListenerContext) {
    this.ctx = ctx;
  }

  async start() {
    if (this.running) {
      this.log('info', 'Zenzap listener already running');
      return;
    }
    this.log('info', 'Starting Zenzap listener');
    this.running = true;

    if (this.ctx.client) {
      await this.discoverTopics();
    }

    this.poller = new ZenzapPoller({
      apiKey: this.ctx.config.apiKey,
      apiSecret: this.ctx.config.apiSecret,
      apiUrl: this.ctx.config.apiUrl,
      pollTimeout: this.ctx.config.pollTimeout,
      offsetFile: this.ctx.config.offsetFile,
    });

    this.poller.start(this.onEvent.bind(this)).catch((err) => {
      this.log('error', 'Poller error', err);
      if (this.ctx.onPollerError) {
        this.ctx.onPollerError(err instanceof Error ? err : new Error(String(err))).catch(() => {});
      }
    });

    this.log('info', `Zenzap listener started (${this.topics.size} topics)`);
  }

  async stop() {
    if (!this.running || !this.poller) return;
    this.log('info', 'Stopping Zenzap listener');
    for (const timer of this.pendingAudioMessages.values()) clearTimeout(timer);
    this.pendingAudioMessages.clear();
    await this.poller.stop();
    this.running = false;
  }

  private cancelPendingAudioTimer(msgId: string): void {
    if (!msgId || !this.pendingAudioMessages.has(msgId)) return;
    clearTimeout(this.pendingAudioMessages.get(msgId));
    this.pendingAudioMessages.delete(msgId);
    this.log('debug', `Audio transcription received for ${msgId}, cancelling fallback timer`);
  }

  private async discoverTopics() {
    try {
      const result = await (this.ctx.client as any).listTopics({ limit: 100 });
      if (result?.topics && Array.isArray(result.topics)) {
        for (const topic of result.topics) {
          this.topics.set(topic.id, {
            id: topic.id,
            name: topic.name || 'Untitled',
            conversationId: `zenzap:${topic.id}`,
            memberCount: Array.isArray(topic.members) ? topic.members.length : 0,
          });
        }
        this.log('info', `Discovered ${this.topics.size} topics`);
      }
    } catch (err) {
      this.log('error', 'Failed to discover topics', err);
    }
  }

  private getTopicInfo(topicId: string): TopicInfo {
    if (this.topics.has(topicId)) {
      return this.topics.get(topicId)!;
    }

    const info: TopicInfo = {
      id: topicId,
      name: `Topic ${topicId.slice(0, 8)}`,
      conversationId: `zenzap:${topicId}`,
      memberCount: 0,
    };
    this.topics.set(topicId, info);
    this.log('info', `Auto-registered topic: zenzap:${topicId}`);

    if (this.ctx.client) {
      (this.ctx.client as any)
        .getTopicDetails(topicId)
        .then((details: any) => {
          const existing = this.topics.get(topicId);
          if (!existing) return;
          if (details?.name) existing.name = details.name;
          if (details?.members)
            existing.memberCount = Array.isArray(details.members)
              ? details.members.filter((m: any) => m?.type !== 'bot').length
              : 0;
        })
        .catch(() => {});
    }

    return info;
  }

  private isBotMentioned(msg: any): boolean {
    const { botMemberId } = this.ctx;
    if (!botMemberId) return false;
    const normalizeProfileId = (value: string) => value.toLowerCase().replace(/^b@/, '');
    const botId = botMemberId.toLowerCase();
    const botIdNormalized = normalizeProfileId(botId);

    const text = typeof msg?.text === 'string' ? msg.text : '';
    const mentionTokens = [...text.matchAll(/<@([^>\s]+)>/g)].map((m) => String(m[1] ?? '').trim());
    if (
      mentionTokens.some((token) => {
        const tokenLower = token.toLowerCase();
        return tokenLower === botId || normalizeProfileId(tokenLower) === botIdNormalized;
      })
    ) {
      return true;
    }

    const mentionedProfiles = Array.isArray(msg?.mentionedProfiles) ? msg.mentionedProfiles : [];
    if (
      mentionedProfiles.some((id: any) => {
        const idLower = String(id ?? '').toLowerCase();
        return idLower === botId || normalizeProfileId(idLower) === botIdNormalized;
      })
    ) {
      return true;
    }

    const mentions = Array.isArray(msg?.mentions) ? msg.mentions : [];
    if (
      mentions.some((m: any) => {
        const idLower = String(m?.id ?? '').toLowerCase();
        return idLower === botId || normalizeProfileId(idLower) === botIdNormalized;
      })
    ) {
      return true;
    }

    return false;
  }

  private shouldRequireMention(topicId: string, memberCount: number): boolean {
    if (this.ctx.controlTopicId && topicId === this.ctx.controlTopicId) return false;
    if (this.ctx.requireMention) return this.ctx.requireMention(topicId, memberCount);
    return false;
  }

  /** Main event router — handles all event types */
  private async onEvent(event: any) {
    const type = event.eventType as string;

    switch (type) {
      case 'message.created':
        await this.handleMessage(event, 'created');
        break;

      case 'message.updated':
        await this.handleMessage(event, 'updated');
        break;

      case 'member.added':
        await this.handleMemberAdded(event);
        break;

      case 'member.removed':
        await this.handleMemberRemoved(event);
        break;

      case 'topic.updated':
        await this.handleTopicUpdated(event);
        break;

      case 'poll_vote.created':
        await this.handlePollVote(event, 'created');
        break;

      case 'poll_vote.deleted':
        await this.handlePollVote(event, 'deleted');
        break;

      // Intentionally ignored
      case 'message.deleted':
      case 'reaction.added':
      case 'reaction.removed':
      case 'webhook.test':
        break;

      default:
        this.log('debug', `Unknown event type: ${type}`);
    }
  }

  private normalizeAttachments(msg: any): ZenzapAttachment[] {
    const raw = msg?.attachments;
    if (!Array.isArray(raw)) return [];
    return raw.map((item: any) => {
      if (typeof item === 'string') {
        return { type: 'file', name: item };
      }
      return item || {};
    });
  }

  private attachmentTranscriptionText(attachments: ZenzapAttachment[]): string | null {
    for (const attachment of attachments) {
      const status = attachment?.transcription?.status;
      const text = attachment?.transcription?.text?.trim();
      if (attachment?.type === 'audio' && status === 'Done' && text) return text;
    }
    return null;
  }

  private static MEDIA_ATTACHMENT_TYPES = new Set<string>(['image', 'video']);

  private static EXT_MIME_MAP: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    ico: 'image/x-icon',
    heic: 'image/heic',
    heif: 'image/heif',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    '3gp': 'video/3gpp',
  };

  private static FALLBACK_MIME: Record<string, string> = {
    image: 'image/jpeg',
    video: 'video/mp4',
  };

  private static inferMimeType(attachment: ZenzapAttachment): string {
    const source = attachment.name || attachment.url || '';
    // Strip query string / fragment, then extract extension
    const clean = source.split(/[?#]/)[0];
    const ext = clean.split('.').pop()?.toLowerCase();
    if (ext && ZenzapListener.EXT_MIME_MAP[ext]) {
      return ZenzapListener.EXT_MIME_MAP[ext];
    }
    return ZenzapListener.FALLBACK_MIME[attachment.type!] ?? `${attachment.type}/*`;
  }

  private extractMediaFromAttachments(attachments: ZenzapAttachment[]): {
    mediaUrls: string[];
    mediaTypes: string[];
  } {
    const mediaUrls: string[] = [];
    const mediaTypes: string[] = [];
    for (const attachment of attachments) {
      if (
        attachment.url &&
        attachment.type &&
        ZenzapListener.MEDIA_ATTACHMENT_TYPES.has(attachment.type)
      ) {
        mediaUrls.push(attachment.url);
        mediaTypes.push(ZenzapListener.inferMimeType(attachment));
      }
    }
    return { mediaUrls, mediaTypes };
  }

  private summarizeAttachment(attachment: ZenzapAttachment, index: number): string {
    const parts = [`- #${index + 1}`];
    if (attachment.type) parts.push(`type=${attachment.type}`);
    if (attachment.name) parts.push(`name="${attachment.name}"`);
    if (attachment.url) parts.push(`url=${attachment.url}`);
    if (attachment.transcription?.status)
      parts.push(`transcription=${attachment.transcription.status}`);
    return parts.join(', ');
  }

  private formatLocation(location: any): string | null {
    if (!location) return null;
    const parts: string[] = [];
    if (location.name) parts.push(String(location.name));
    const coords = [location.latitude, location.longitude].filter(Boolean).join(', ');
    if (coords) parts.push(`coords=${coords}`);
    if (location.address) parts.push(String(location.address));
    if (!parts.length) return null;
    return `Location: ${parts.join(' | ')}`;
  }

  private formatTask(task: any): string | null {
    if (!task) return null;
    const parts: string[] = [];
    if (task.action) parts.push(`action=${task.action}`);
    if (task.title) parts.push(`title="${task.title}"`);
    if (task.status) parts.push(`status=${task.status}`);
    if (task.assignee) parts.push(`assignee=${task.assignee}`);
    if (typeof task.dueDate === 'number') parts.push(`dueDate=${task.dueDate}`);
    if (task.text) parts.push(`details="${task.text}"`);
    if (!parts.length) return null;
    return `Task: ${parts.join(', ')}`;
  }

  private formatMentions(mentions: any): string | null {
    if (!Array.isArray(mentions) || mentions.length === 0) return null;
    const lines = mentions
      .filter((m: any) => m?.id || m?.name)
      .map((m: any) => {
        const display = m.name ?? m.id;
        const parts: string[] = [`"${display}"`];
        if (m.id) parts.push(`memberId=${m.id}`);
        return `- ${parts.join(', ')}`;
      });
    if (!lines.length) return null;
    return `Mentioned members:\n${lines.join('\n')}`;
  }

  private formatPoll(poll: any): string | null {
    if (!poll) return null;

    // Cap free-text fields to prevent prompt injection via crafted poll content.
    const cap = (s: string, max = 200) => (s.length > max ? `${s.slice(0, max)}…` : s);
    // Sanitize to remove control characters that could disrupt prompt formatting.
    const sanitize = (s: string) => s.replace(/[\r\n\t]/g, ' ').trim();
    const clean = (s: string, max?: number) => cap(sanitize(s), max);

    const parts: string[] = [];
    if (poll.title) parts.push(`"${clean(String(poll.title))}"`);
    if (poll.subtitle) parts.push(`subtitle="${clean(String(poll.subtitle))}"`);
    // Include the attachment ID so the agent can pass it to zenzap_cast_poll_vote.
    if (poll.id) parts.push(`attachmentId=${poll.id}`);
    if (Array.isArray(poll.options) && poll.options.length) {
      const opts = poll.options
        .map((o: any) => {
          if (typeof o === 'string') return clean(o, 100);
          // Include optionId in brackets so the agent knows which id to vote with.
          const id = o?.id ? `[${o.id}]` : '';
          const text = o?.text ?? o?.id ?? '';
          return text ? `${id} ${clean(String(text), 100)}`.trim() : '';
        })
        .filter(Boolean)
        .join(' / ');
      if (opts) parts.push(`options: ${opts}`);
    }
    if (poll.selectionType) parts.push(`type=${poll.selectionType}`);
    if (poll.anonymous) parts.push('anonymous=true');
    if (poll.status) parts.push(`status=${poll.status}`);
    if (!parts.length) return null;
    return `Poll: ${parts.join(' | ')}`;
  }

  private formatContact(contact: any): string | null {
    if (!contact) return null;
    const parts: string[] = [];
    if (contact.name) parts.push(`name="${contact.name}"`);
    if (Array.isArray(contact.phoneNumbers) && contact.phoneNumbers.length) {
      parts.push(`phones=${contact.phoneNumbers.join(', ')}`);
    }
    if (Array.isArray(contact.emails) && contact.emails.length) {
      parts.push(`emails=${contact.emails.join(', ')}`);
    }
    if (contact.role) parts.push(`role=${contact.role}`);
    if (contact.profileId) parts.push(`profileId=${contact.profileId}`);
    if (!parts.length) return null;
    return `Contact: ${parts.join(', ')}`;
  }

  private async transcribeAudioIfNeeded(
    msg: any,
    attachments: ZenzapAttachment[],
  ): Promise<string | null> {
    if (!this.ctx.transcribeAudio) return null;

    for (const attachment of attachments) {
      if (attachment?.type !== 'audio' || !attachment?.url) continue;
      const key = attachment.id || attachment.url;
      if (this.audioTranscriptCache.has(key)) return this.audioTranscriptCache.get(key) || null;

      try {
        const transcript = await this.ctx.transcribeAudio(attachment, {
          topicId: msg?.topicId || 'unknown',
          messageId: msg?.id,
          senderId: msg?.senderId,
        });
        if (transcript?.trim()) {
          const cleaned = transcript.trim();
          this.audioTranscriptCache.set(key, cleaned);
          return cleaned;
        }
      } catch (err: any) {
        this.log('debug', `Local audio transcription failed: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * Resolves the text body for an audio message.
   * Returns the transcription text if available (from Zenzap or local Whisper),
   * or null if transcription is still pending — signalling the caller to hold and
   * wait for the message.updated event that carries the completed transcription.
   */
  private async resolveAudioBody(
    msg: any,
    attachments: ZenzapAttachment[],
    rawText: string,
    details: string[],
  ): Promise<string | null> {
    let transcriptionText = this.attachmentTranscriptionText(attachments);
    if (!transcriptionText && !rawText) {
      transcriptionText = await this.transcribeAudioIfNeeded(msg, attachments);
      if (transcriptionText) details.push('Audio transcription source: local-whisper');
    }
    return transcriptionText ?? null;
  }

  /**
   * Builds the message body for dispatch to the agent.
   * Returns null specifically for audio messages where no transcription is available yet,
   * signalling the caller to hold and wait for the message.updated event.
   */
  private async buildMessageBody(msg: any): Promise<string | null> {
    const messageType = typeof msg?.type === 'string' ? msg.type : 'text';
    const rawText = typeof msg?.text === 'string' ? msg.text.trim() : '';
    const attachments = this.normalizeAttachments(msg);
    const body: string[] = [];
    const details: string[] = [];

    if (rawText) body.push(rawText);

    if (messageType === 'audio') {
      const transcriptionText = await this.resolveAudioBody(msg, attachments, rawText, details);
      if (!rawText) {
        if (transcriptionText) {
          body.push(transcriptionText);
        } else {
          return null;
        }
      }
    }

    if (messageType !== 'text') details.push(`Message type: ${messageType}`);
    if (msg?.parentId) details.push(`Reply to message ID: ${msg.parentId}`);

    if (attachments.length) {
      details.push(`Attachments (${attachments.length}):`);
      attachments.forEach((attachment, idx) =>
        details.push(this.summarizeAttachment(attachment, idx)),
      );
    }

    const mentionLines = this.formatMentions(msg?.mentions);
    if (mentionLines) details.push(mentionLines);

    const locationLine = this.formatLocation(msg?.location);
    if (locationLine) details.push(locationLine);

    const taskLine = this.formatTask(msg?.task);
    if (taskLine) details.push(taskLine);

    const contactLine = this.formatContact(msg?.contact);
    if (contactLine) details.push(contactLine);

    const pollLine = this.formatPoll(msg?.poll);
    if (pollLine) details.push(pollLine);

    if (!body.length && !details.length) return '';
    if (!body.length) body.push(`[${messageType} message]`);
    if (!details.length) return body.join('\n');

    return `${body.join('\n')}\n\n${details.join('\n')}`.trim();
  }

  /** Builds a fallback body for audio messages when transcription never arrives. */
  private buildAudioFallbackBody(msg: any): string {
    const attachments = this.normalizeAttachments(msg);
    const details: string[] = ['Message type: audio'];
    if (msg?.parentId) details.push(`Reply to message ID: ${msg.parentId}`);
    if (attachments.length) {
      details.push(`Attachments (${attachments.length}):`);
      attachments.forEach((a, idx) => details.push(this.summarizeAttachment(a, idx)));
    }
    const locationLine = this.formatLocation(msg?.location);
    if (locationLine) details.push(locationLine);
    return `[audio message]\n\n${details.join('\n')}`.trim();
  }

  private shouldProcessMessageUpdate(event: any): boolean {
    const msg = event?.data?.message;
    if (!msg) return false;

    const updatedFields = Array.isArray(event?.data?.updatedFields) ? event.data.updatedFields : [];
    const meaningfulFields = new Set([
      'text',
      'attachments',
      'location',
      'task',
      'contact',
      'poll',
      'parentId',
    ]);
    const touchedMeaningfulField = updatedFields.some((field: string) =>
      meaningfulFields.has(field),
    );
    if (touchedMeaningfulField) return true;

    if (typeof msg?.text === 'string' && msg.text.trim()) return true;

    const hasCompletedAudioTranscription = this.normalizeAttachments(msg).some(
      (a) =>
        a?.type === 'audio' &&
        a?.transcription?.status === 'Done' &&
        Boolean(a?.transcription?.text?.trim()),
    );
    return hasCompletedAudioTranscription;
  }

  private async dispatchMessageBody(
    event: any,
    topic: TopicInfo,
    msg: any,
    formattedBody: string,
    botMentioned: boolean,
    mentionRequired: boolean,
    phase: 'created' | 'updated',
  ): Promise<void> {
    const signatureKey = `${phase}:${msg?.id ?? 'unknown'}`;
    const signatureValue = `${msg?.updatedAt ?? msg?.createdAt ?? ''}:${formattedBody}`;
    if (this.messageSignatures.get(signatureKey) === signatureValue) return;
    this.messageSignatures.set(signatureKey, signatureValue);

    if (this.ctx.sendMessage) {
      try {
        const attachments = this.normalizeAttachments(msg);
        const { mediaUrls, mediaTypes } = this.extractMediaFromAttachments(attachments);
        if (mediaUrls.length > 0) {
          this.log('info', `Attaching ${mediaUrls.length} media item(s) for message ${msg?.id}`, {
            mediaUrls,
            mediaTypes,
          });
        }
        await this.ctx.sendMessage({
          channel: 'zenzap',
          conversation: topic.conversationId,
          source: msg?.senderId,
          text: formattedBody,
          ...(mediaUrls.length > 0 && { mediaUrls, mediaTypes }),
          timestamp: new Date(msg?.updatedAt || msg?.createdAt || Date.now()).toISOString(),
          metadata: {
            topicId: topic.id,
            topicName: topic.name,
            messageId: msg?.id,
            sender: msg?.senderName,
            senderType: msg?.senderType,
            messageType: msg?.type || 'text',
            parentId: msg?.parentId,
            attachments,
            updatedFields: event?.data?.updatedFields,
            phase,
            memberCount: topic.memberCount,
            botMentioned,
            mentionRequired,
          },
          raw: event,
        });
      } catch (err) {
        this.log('error', 'Failed to send message to OpenClaw', err);
      }
    }
  }

  /**
   * Holds an audio message whose transcription is still pending and sets a fallback timer.
   * Called only when buildMessageBody returns null (transcription not yet available).
   * On timeout, dispatches a fallback body so the agent is always notified.
   */
  private handleAudioTranscriptionGating(
    event: any,
    topic: TopicInfo,
    msg: any,
    botMentioned: boolean,
    mentionRequired: boolean,
    phase: 'created' | 'updated',
  ): void {
    if (phase !== 'created' || !msg?.id) return;

    const msgId: string = msg.id;
    const fallbackBody = this.buildAudioFallbackBody(msg);

    this.log('debug', `Audio transcription pending for ${msgId}, waiting up to ${AUDIO_TRANSCRIPTION_TIMEOUT_MS}ms`);

    const timer = setTimeout(() => {
      this.pendingAudioMessages.delete(msgId);
      this.log('debug', `Audio transcription timeout for ${msgId}, dispatching fallback`);
      void this.dispatchMessageBody(event, topic, msg, fallbackBody, botMentioned, mentionRequired, 'created');
    }, AUDIO_TRANSCRIPTION_TIMEOUT_MS);

    if (this.pendingAudioMessages.size >= 200) {
      const oldestKey = this.pendingAudioMessages.keys().next().value;
      if (oldestKey) {
        clearTimeout(this.pendingAudioMessages.get(oldestKey));
        this.pendingAudioMessages.delete(oldestKey);
      }
    }

    this.pendingAudioMessages.set(msgId, timer);
  }

  private async handleMessage(event: any, phase: 'created' | 'updated') {
    const topicId = event.data?.message?.topicId;
    if (!topicId) return;
    if (phase === 'updated' && !this.shouldProcessMessageUpdate(event)) return;

    const topic = this.getTopicInfo(topicId);
    const msg = event.data?.message;

    this.log('debug', 'Received Zenzap event', {
      eventType: event.eventType,
      topic: topic.name,
      conversation: topic.conversationId,
    });

    // Skip own messages entirely
    if (msg?.senderId === this.ctx.botMemberId) return;

    const botMentioned = this.isBotMentioned(msg);

    if (phase === 'created' && msg?.id && this.ctx.client) {
      this.ctx.client.markMessageRead(msg.id).catch(() => {});
    }

    const mentionRequired = this.shouldRequireMention(topicId, topic.memberCount);

    const formattedBody = await this.buildMessageBody(msg);

    // null means audio with transcription still pending — hold and wait for message.updated
    if (formattedBody === null) {
      this.handleAudioTranscriptionGating(event, topic, msg, botMentioned, mentionRequired, phase);
      return;
    }

    // Transcription update arrived — cancel any pending fallback timer
    this.cancelPendingAudioTimer(msg?.id);

    if (!formattedBody) return;

    await this.dispatchMessageBody(event, topic, msg, formattedBody, botMentioned, mentionRequired, phase);
  }

  private async handlePollVote(event: any, phase: 'created' | 'deleted'): Promise<void> {
    const { topicId, attachmentId, optionId, voterId, messageId, pollVoteId } = event.data ?? {};
    if (!topicId || !attachmentId) {
      this.log('info', `Dropping poll_vote.${phase}: missing topicId or attachmentId`, event.data);
      return;
    }

    const topic = this.getTopicInfo(topicId);

    this.log('info', `Poll vote ${phase}: voter=${voterId} option=${optionId} attachment=${attachmentId} topic=${topicId}`);

    const action = phase === 'created' ? 'voted for' : 'removed vote for';
    // messageId is included so the agent can fetch the poll message to resolve optionId → option text.
    const msgHint = messageId ? ` (messageId=${messageId} — look up the poll message to resolve the option text)` : '';
    const body = `[poll_vote.${phase}] voterId=${voterId} ${action} optionId=${optionId} on poll attachmentId=${attachmentId} ${msgHint}`;
    try {
      await this.ctx.sendMessage({
        channel: 'zenzap',
        conversation: topic.conversationId,
        source: voterId,
        text: body,
        timestamp: new Date(event.createdAt || Date.now()).toISOString(),
        metadata: {
          topicId: topic.id,
          topicName: topic.name,
          messageId,
          attachmentId,
          pollVoteId,
          optionId,
          voterId,
          eventType: `poll_vote.${phase}`,
        },
        raw: event,
      });
    } catch (err) {
      this.log('error', 'Failed to dispatch poll vote event', err);
    }
  }

  private async handleMemberAdded(event: any) {
    const { topicId, memberId, memberIds } = event.data ?? {};
    if (!topicId) return;

    // Update member count
    const topic = this.getTopicInfo(topicId);
    const added = memberIds?.length ?? 1;
    topic.memberCount = Math.max(0, topic.memberCount + added);

    // Detect bot joining a new topic
    const botId = this.ctx.botMemberId;
    const botJoined = botId && (memberId === botId || memberIds?.includes(botId));

    if (this.ctx.client) {
      try {
        const details = await (this.ctx.client as any).getTopicDetails(topicId);
        const t = this.topics.get(topicId);
        if (t) {
          // Prefer API-provided memberCount field (may exist even if not in types),
          // fall back to members array length (may be truncated for large topics).
          if (typeof (details as any)?.memberCount === 'number') {
            t.memberCount = (details as any).memberCount;
          } else if (Array.isArray(details?.members)) {
            t.memberCount = details.members.filter((m: any) => m?.type !== 'bot').length;
          }
          if (details?.name) t.name = details.name;
        }
      } catch {
        /* best-effort */
      }
    }

    if (botJoined) {
      this.log('info', `Bot added to topic: ${topic.name} (${topicId})`);
      if (this.ctx.onBotJoinedTopic) {
        await this.ctx.onBotJoinedTopic(topicId, topic.name, topic.memberCount).catch((err) => {
          this.log('error', 'onBotJoinedTopic error', err);
        });
      }
    }
  }

  private async handleMemberRemoved(event: any) {
    const { topicId, memberIds } = event.data ?? {};
    if (!topicId) return;

    const topic = this.topics.get(topicId);
    if (!topic) return;

    const removed = memberIds?.length ?? 1;
    topic.memberCount = Math.max(0, topic.memberCount - removed);

    this.log('debug', `Member removed from topic ${topic.name}, count now ~${topic.memberCount}`);
  }

  private async handleTopicUpdated(event: any) {
    const { topicId, name, description } = event.data ?? {};
    if (!topicId) return;

    const topic = this.topics.get(topicId);
    if (!topic) return;

    if (name) {
      topic.name = name;
      this.log('info', `Topic renamed: ${topicId} → "${name}"`);
    }
    if (description !== undefined) {
      this.log('debug', `Topic description updated: ${topicId}`);
    }
  }

  private log(level: string, msg: string, data?: any) {
    if (this.ctx.logger) {
      (this.ctx.logger as any)[level](msg, data);
    } else {
      console.log(`[ZenzapListener:${level}] ${msg}`, data || '');
    }
  }
}
