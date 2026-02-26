import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZenzapListener } from '../listener.js';

// Minimal mock client
function makeMockClient(overrides: Record<string, any> = {}) {
  return {
    listTopics: vi.fn().mockResolvedValue({
      topics: [
        { id: 'topic-1', name: 'Engineering', members: ['user-a', 'user-b', 'bot-id'] },
        { id: 'topic-2', name: 'Direct', members: ['user-a', 'bot-id'] },
      ],
      hasMore: false,
    }),
    getTopicDetails: vi.fn().mockResolvedValue({
      id: 'topic-1',
      name: 'Engineering',
      members: ['user-a', 'user-b', 'bot-id'],
    }),
    getTopicMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    markMessageRead: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeEvent(type: string, data: any) {
  return { updateId: 'test-id', eventType: type, createdAt: Date.now(), data };
}

function makeMessageEvent(topicId: string, text: string, senderId = 'user-a', senderType = 'user') {
  return makeEvent('message.created', {
    message: {
      id: `msg-${Date.now()}`,
      topicId,
      senderId,
      senderName: 'Alice',
      senderType,
      type: 'text',
      text,
      createdAt: Date.now(),
    },
  });
}

function makeUpdatedMessageEvent(message: Record<string, any>, updatedFields: string[] = ['text']) {
  return makeEvent('message.updated', {
    message: {
      id: `msg-${Date.now()}`,
      senderName: 'Alice',
      senderType: 'user',
      type: 'text',
      createdAt: Date.now() - 5000,
      updatedAt: Date.now(),
      ...message,
    },
    updatedFields,
  });
}

describe('ZenzapListener', () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let onBotJoinedTopic: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMessage = vi.fn().mockResolvedValue(undefined);
    onBotJoinedTopic = vi.fn().mockResolvedValue(undefined);
  });

  describe('event routing', () => {
    it('dispatches message.created to sendMessage', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        botMemberId: 'bot-id',
        client: client as any,
        sendMessage,
        requireMention: () => false, // never require mention
      });
      await listener['discoverTopics']();
      await listener['onEvent'](makeMessageEvent('topic-1', 'hello'));
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].text).toBe('hello');
      expect(sendMessage.mock.calls[0][0].metadata.botMentioned).toBe(false);
    });

    it('ignores message.deleted', async () => {
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        sendMessage,
      });
      await listener['onEvent'](
        makeEvent('message.deleted', { message: { id: '1', topicId: 'topic-1' } }),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('ignores reaction.added', async () => {
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        sendMessage,
      });
      await listener['onEvent'](makeEvent('reaction.added', { topicId: 'topic-1' }));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('ignores webhook.test', async () => {
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        sendMessage,
      });
      await listener['onEvent'](makeEvent('webhook.test', {}));
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('dispatches message.updated when transcription is done', async () => {
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        sendMessage,
      });
      await listener['onEvent'](
        makeUpdatedMessageEvent(
          {
            topicId: 'topic-1',
            senderId: 'user-a',
            type: 'audio',
            text: '',
            attachments: [
              {
                type: 'audio',
                name: 'voice-note.mp3',
                url: 'https://files.example/voice-note.mp3',
                transcription: { status: 'Done', text: 'voice transcript ready' },
              },
            ],
          },
          ['attachments'],
        ),
      );
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].text).toContain('voice transcript ready');
    });
  });

  describe('bot message filtering', () => {
    it('forwards messages from other bots (senderType=bot) to sendMessage for bot-to-bot', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        botMemberId: 'bot-id',
        client: client as any,
        sendMessage,
        requireMention: () => false,
      });
      await listener['onEvent'](
        makeMessageEvent('topic-1', 'I am a bot reply', 'other-bot', 'bot'),
      );
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].text).toBe('I am a bot reply');
    });

    it('skips own messages (senderId === botMemberId)', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        botMemberId: 'bot-id',
        client: client as any,
        sendMessage,
        requireMention: () => false,
      });
      await listener['onEvent'](makeMessageEvent('topic-1', 'my own message', 'bot-id', 'bot'));
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('mention gating', () => {
    it('passes message through with mentionRequired=true when bot not mentioned', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        botMemberId: 'b@bot-uuid',
        client: client as any,
        sendMessage,
        requireMention: (_topicId, memberCount) => memberCount > 2,
      });
      await listener['discoverTopics'](); // topic-1 has 3 members
      await listener['onEvent'](makeMessageEvent('topic-1', 'hey team'));
      // Message is passed through for context (not dropped), with mentionRequired=true and botMentioned=false
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].metadata.mentionRequired).toBe(true);
      expect(sendMessage.mock.calls[0][0].metadata.botMentioned).toBe(false);
    });

    it('dispatches when bot is mentioned in group topic', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        botMemberId: 'b@bot-uuid',
        client: client as any,
        sendMessage,
        requireMention: (_topicId, memberCount) => memberCount > 2,
      });
      await listener['discoverTopics']();
      await listener['onEvent'](makeMessageEvent('topic-1', 'hey @b@bot-uuid can you help?'));
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].metadata.botMentioned).toBe(true);
    });

    it('always dispatches in 1-on-1 topic (2 members)', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        botMemberId: 'b@bot-uuid',
        client: client as any,
        sendMessage,
        requireMention: (_topicId, memberCount) => memberCount > 2,
      });
      await listener['discoverTopics'](); // topic-2 has 2 members
      await listener['onEvent'](makeMessageEvent('topic-2', 'hi'));
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].metadata.botMentioned).toBe(false);
    });

    it('detects mention via mentionedProfiles for non-text messages', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        botMemberId: 'b@bot-uuid',
        client: client as any,
        sendMessage,
        requireMention: () => true,
      });
      await listener['discoverTopics']();
      await listener['onEvent'](
        makeEvent('message.created', {
          message: {
            id: `msg-${Date.now()}`,
            topicId: 'topic-1',
            senderId: 'user-a',
            senderName: 'Alice',
            senderType: 'user',
            type: 'image',
            text: '',
            mentionedProfiles: ['b@bot-uuid'],
            attachments: [
              { type: 'image', name: 'shot.png', url: 'https://files.example/shot.png' },
            ],
            createdAt: Date.now(),
          },
        }),
      );
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].metadata.botMentioned).toBe(true);
    });
  });

  describe('rich message formatting', () => {
    it('converts image attachment messages into agent-readable text', async () => {
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        sendMessage,
      });
      await listener['onEvent'](
        makeEvent('message.created', {
          message: {
            id: `msg-${Date.now()}`,
            topicId: 'topic-1',
            senderId: 'user-a',
            senderName: 'Alice',
            senderType: 'user',
            type: 'image',
            text: '',
            attachments: [
              { type: 'image', name: 'shot.png', url: 'https://files.example/shot.png' },
            ],
            createdAt: Date.now(),
          },
        }),
      );
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].text).toContain('Message type: image');
      expect(sendMessage.mock.calls[0][0].text).toContain('Attachments (1):');
    });

    it('uses local transcriber fallback for audio when upstream transcription is pending', async () => {
      const transcribeAudio = vi.fn().mockResolvedValue('local whisper transcript');
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        sendMessage,
        transcribeAudio,
      });
      await listener['onEvent'](
        makeEvent('message.created', {
          message: {
            id: `msg-${Date.now()}`,
            topicId: 'topic-1',
            senderId: 'user-a',
            senderName: 'Alice',
            senderType: 'user',
            type: 'audio',
            text: '',
            attachments: [
              {
                id: 'att-1',
                type: 'audio',
                name: 'voice-note.mp3',
                url: 'https://files.example/voice-note.mp3',
                transcription: { status: 'Pending' },
              },
            ],
            createdAt: Date.now(),
          },
        }),
      );
      expect(transcribeAudio).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].text).toContain('local whisper transcript');
      expect(sendMessage.mock.calls[0][0].text).toContain(
        'Audio transcription source: local-whisper',
      );
    });
  });

  describe('topic.updated', () => {
    it('updates topic name in cache', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        client: client as any,
        sendMessage,
      });
      await listener['discoverTopics']();
      expect(listener['topics'].get('topic-1')?.name).toBe('Engineering');

      await listener['onEvent'](
        makeEvent('topic.updated', {
          topicId: 'topic-1',
          name: 'Engineering Team',
          changes: { name: 'Engineering Team' },
        }),
      );
      expect(listener['topics'].get('topic-1')?.name).toBe('Engineering Team');
    });
  });

  describe('member.added', () => {
    it('increments member count', async () => {
      const client = makeMockClient({
        getTopicDetails: vi.fn().mockResolvedValue({
          id: 'topic-1',
          name: 'Engineering',
          members: ['user-a', 'user-b', 'bot-id', 'user-c'],
        }),
      });
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        botMemberId: 'bot-id',
        client: client as any,
        sendMessage,
        onBotJoinedTopic,
      });
      await listener['discoverTopics']();
      expect(listener['topics'].get('topic-1')?.memberCount).toBe(3);

      await listener['onEvent'](
        makeEvent('member.added', {
          topicId: 'topic-1',
          memberId: 'user-c',
          memberIds: ['user-c'],
          memberType: 'user',
        }),
      );
      // After optimistic update: 3 + 1 = 4
      expect(listener['topics'].get('topic-1')?.memberCount).toBe(4);
      expect(onBotJoinedTopic).not.toHaveBeenCalled();
    });

    it('calls onBotJoinedTopic when bot is added', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        botMemberId: 'bot-id',
        client: client as any,
        sendMessage,
        onBotJoinedTopic,
      });
      await listener['discoverTopics']();

      await listener['onEvent'](
        makeEvent('member.added', {
          topicId: 'topic-1',
          memberId: 'bot-id',
          memberIds: ['bot-id'],
          memberType: 'bot',
        }),
      );
      expect(onBotJoinedTopic).toHaveBeenCalledWith('topic-1', 'Engineering', expect.any(Number));
    });
  });

  describe('member.removed', () => {
    it('decrements member count', async () => {
      const client = makeMockClient();
      const listener = new ZenzapListener({
        config: { apiKey: 't', apiSecret: 's', apiUrl: 'http://x', pollTimeout: 1 },
        client: client as any,
        sendMessage,
      });
      await listener['discoverTopics']();
      expect(listener['topics'].get('topic-1')?.memberCount).toBe(3);

      await listener['onEvent'](
        makeEvent('member.removed', {
          topicId: 'topic-1',
          memberIds: ['user-b'],
        }),
      );
      expect(listener['topics'].get('topic-1')?.memberCount).toBe(2);
    });
  });
});
