/**
 * OpenClaw Tools for Zenzap
 */

import { getClient } from '@zenzap-co/sdk';

const PROFILE_ID_PATTERN = /^(?:[ub]@)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeMentionIds(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const cleaned = values
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0)
    .map((value) => {
      // Accept raw ids or already-wrapped tokens like <@...>.
      const match = /^<@([^>\s]+)>$/.exec(value);
      const id = (match ? match[1] : value).trim();
      return PROFILE_ID_PATTERN.test(id) ? id : null;
    })
    .filter((value): value is string => value !== null);
  return [...new Set(cleaned)];
}

function applyMentionsToText(text: string, mentionIds: string[]): string {
  if (!mentionIds.length) return text;

  const missingTokens = mentionIds
    .map((id) => `<@${id}>`)
    .filter((token) => !text.includes(token));

  if (!missingTokens.length) return text;
  if (!text.trim()) return missingTokens.join(' ');
  return `${text} ${missingTokens.join(' ')}`;
}

export const tools = [
  {
    id: 'zenzap_get_me',
    name: 'Get My Profile',
    description:
      'Get your own bot profile: name, member ID, and status. Use this to confirm your identity or refresh your own details.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    id: 'zenzap_send_message',
    name: 'Send Zenzap Message',
    description: 'Send a text message to a Zenzap topic',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'UUID of the target topic' },
        text: { type: 'string', description: 'Message text (max 10000 characters)' },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional member profile IDs to @mention. The tool appends missing <@profileId> tokens to text.',
        },
      },
      required: ['topicId', 'text'],
    },
  },
  {
    id: 'zenzap_send_image',
    name: 'Send Zenzap Image',
    description: 'Send an image to a Zenzap topic using either a URL or base64 data, with optional caption',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'UUID of the target topic' },
        imageUrl: { type: 'string', description: 'Public or signed URL to the image to upload. Use either imageUrl or imageBase64.' },
        imageBase64: { type: 'string', description: 'Base64-encoded image data (raw base64 or data URI). Use either imageBase64 or imageUrl.' },
        mimeType: { type: 'string', description: 'Optional MIME type for imageBase64 payloads (e.g. image/png)' },
        caption: { type: 'string', description: 'Optional caption for the image' },
        externalId: { type: 'string', description: 'Optional external ID for idempotency/tracking' },
        fileName: { type: 'string', description: 'Optional override for uploaded filename' },
      },
      required: ['topicId'],
    },
  },
  {
    id: 'zenzap_create_topic',
    name: 'Create Zenzap Topic',
    description: 'Create a new topic (group chat) in Zenzap with specified members',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Topic name (max 64 characters)' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of member UUIDs to add',
        },
        description: { type: 'string', description: 'Optional topic description' },
        externalId: { type: 'string', description: 'Optional external ID (unique per bot)' },
      },
      required: ['name', 'members'],
    },
  },
  {
    id: 'zenzap_get_topic',
    name: 'Get Zenzap Topic',
    description: 'Get details of a topic including its name, description, and member list',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'UUID of the topic' },
      },
      required: ['topicId'],
    },
  },
  {
    id: 'zenzap_update_topic',
    name: 'Update Zenzap Topic',
    description: 'Update a topic name and/or description',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'UUID of the topic to update' },
        name: { type: 'string', description: 'New topic name (max 64 characters)' },
        description: { type: 'string', description: 'New topic description' },
      },
      required: ['topicId'],
    },
  },
  {
    id: 'zenzap_add_members',
    name: 'Add Members to Zenzap Topic',
    description: 'Add members to a topic (max 5 per call). Members must exist in the organization.',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'UUID of the topic' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of member UUIDs to add (max 5)',
        },
      },
      required: ['topicId', 'members'],
    },
  },
  {
    id: 'zenzap_remove_members',
    name: 'Remove Members from Zenzap Topic',
    description: 'Remove members from a topic (max 5 per call)',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'UUID of the topic' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of member UUIDs to remove (max 5)',
        },
      },
      required: ['topicId', 'members'],
    },
  },
  {
    id: 'zenzap_get_member',
    name: 'Get Zenzap Member',
    description:
      'Look up a member by their ID to get their name, email, and type (user/bot). Use this to resolve who sent a message when you only have their member ID.',
    inputSchema: {
      type: 'object',
      properties: {
        memberId: { type: 'string', description: 'Member UUID (e.g. the senderId from a message)' },
      },
      required: ['memberId'],
    },
  },
  {
    id: 'zenzap_list_members',
    name: 'List Zenzap Members',
    description: 'List or search members in the organization. Use this to discover who is in the workspace — returns name, ID, email, and type for each member.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max members to return (default: 50)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
        emails: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Filter by one or more email addresses. Accepts comma-separated string or string array.',
        },
        email: { type: 'string', description: 'Deprecated alias for emails (single address).' },
      },
    },
  },
  {
    id: 'zenzap_list_topics',
    name: 'List Zenzap Topics',
    description: 'List all topics the bot is a member of',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max topics to return (default: 50)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
    },
  },
  {
    id: 'zenzap_list_tasks',
    name: 'List Zenzap Tasks',
    description: 'List tasks the bot can access, optionally filtered by topic, status, or assignee. Use this before updating tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'Optional topic UUID to list tasks from a single topic' },
        status: { type: 'string', enum: ['Open', 'Done'], description: 'Optional task status filter' },
        assignee: {
          type: 'string',
          description: 'Optional assignee member UUID. Use empty string ("") to list unassigned tasks.',
        },
        limit: { type: 'number', description: 'Max tasks to return (default: 50, max: 100)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
    },
  },
  {
    id: 'zenzap_get_task',
    name: 'Get Zenzap Task',
    description: 'Get full details for a specific task by ID',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'UUID of the task' },
      },
      required: ['taskId'],
    },
  },
  {
    id: 'zenzap_create_task',
    name: 'Create Zenzap Task',
    description: 'Create a task in a Zenzap topic with optional assignee and due date',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'UUID of the topic to create the task in' },
        title: { type: 'string', description: 'Task title (max 256 characters)' },
        description: { type: 'string', description: 'Task description (max 10000 characters)' },
        assignee: { type: 'string', description: 'Member UUID to assign (must be a topic member)' },
        assignees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Deprecated: if provided, first member UUID will be used as assignee',
        },
        dueDate: {
          type: 'number',
          description:
            'Due date as Unix timestamp in milliseconds (e.g. Date.now() + 86400000 for tomorrow)',
        },
      },
      required: ['topicId', 'title'],
    },
  },
  {
    id: 'zenzap_update_task',
    name: 'Update Zenzap Task',
    description: 'Update task fields: rename, description, assignee/unassign, or status (Done/Open)',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'UUID of the task to update' },
        topicId: {
          type: 'string',
          description: 'Topic UUID. Required when changing status (Done/Open).',
        },
        name: { type: 'string', description: 'New task title (alias of title). Use either name OR title.' },
        title: { type: 'string', description: 'New task title. Use either title OR name.' },
        description: { type: 'string', description: 'New task description' },
        assignee: {
          type: 'string',
          description: 'Assignee member UUID. Use empty string ("") to unassign.',
        },
        dueDate: {
          type: 'number',
          description:
            'Due date as Unix timestamp in milliseconds. Set to 0 to clear the due date.',
        },
        status: {
          type: 'string',
          enum: ['Open', 'Done'],
          description: 'Set to Done to close task, Open to reopen task',
        },
      },
      required: ['taskId'],
    },
  },
  {
    id: 'zenzap_get_messages',
    name: 'Get Zenzap Topic Messages',
    description:
      'Fetch message history from a topic. Useful for catching up on what was discussed, summarizing a conversation, or finding a specific message.',
    inputSchema: {
      type: 'object',
      properties: {
        topicId: { type: 'string', description: 'UUID of the topic' },
        limit: {
          type: 'number',
          description: 'Number of messages to fetch (default: 30, max: 100)',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'asc = oldest first, desc = newest first (default: desc)',
        },
        before: { type: 'number', description: 'Fetch messages before this Unix timestamp (ms)' },
        after: { type: 'number', description: 'Fetch messages after this Unix timestamp (ms)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
      required: ['topicId'],
    },
  },
  {
    id: 'zenzap_react',
    name: 'React to Zenzap Message',
    description:
      'Add an emoji reaction to a message. Use this instead of a text reply when you have completed a simple action and have nothing more to say (e.g. task created, member added). Prefer ✅ for success.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'UUID of the message to react to' },
        reaction: { type: 'string', description: 'Emoji to react with (e.g. ✅, 👍, ❤️, 👀)' },
      },
      required: ['messageId', 'reaction'],
    },
  },
];

export async function executeTool(toolId: string, input: any): Promise<any> {
  const client = getClient();

  switch (toolId) {
    case 'zenzap_get_me':
      return client.getCurrentMember();

    case 'zenzap_send_message': {
      const topicId = typeof input?.topicId === 'string' ? input.topicId.trim() : '';
      if (!topicId) {
        throw new Error('topicId is required and must be a non-empty string.');
      }
      if (typeof input?.text !== 'string') {
        throw new Error('text must be a string.');
      }
      const mentionIds = normalizeMentionIds(input.mentions);
      const text = applyMentionsToText(input.text, mentionIds);
      return client.sendMessage({ topicId, text });
    }

    case 'zenzap_send_image': {
      const hasImageUrl = typeof input.imageUrl === 'string' && input.imageUrl.trim().length > 0;
      const hasImageBase64 = typeof input.imageBase64 === 'string' && input.imageBase64.trim().length > 0;
      if (hasImageUrl === hasImageBase64) {
        throw new Error('Provide exactly one of imageUrl or imageBase64.');
      }
      return client.sendImageMessage({
        topicId: input.topicId,
        imageUrl: hasImageUrl ? input.imageUrl : undefined,
        imageBase64: hasImageBase64 ? input.imageBase64 : undefined,
        mimeType: input.mimeType,
        caption: input.caption,
        externalId: input.externalId,
        fileName: input.fileName,
      });
    }

    case 'zenzap_create_topic':
      return client.createTopic({
        name: input.name,
        members: input.members,
        description: input.description,
        externalId: input.externalId,
      });

    case 'zenzap_get_topic':
      return client.getTopicDetails(input.topicId);

    case 'zenzap_update_topic':
      return client.updateTopic(input.topicId, {
        name: input.name,
        description: input.description,
      });

    case 'zenzap_add_members':
      return client.addMembersToTopic(input.topicId, input.members);

    case 'zenzap_remove_members':
      return client.removeMembersFromTopic(input.topicId, input.members);

    case 'zenzap_get_member':
      return client.getMember(input.memberId);

    case 'zenzap_list_members':
      return client.listMembers({
        limit: input.limit || 50,
        cursor: input.cursor,
        emails: input.emails ?? input.email,
      });

    case 'zenzap_list_topics':
      return client.listTopics({ limit: input.limit || 50, cursor: input.cursor });

    case 'zenzap_list_tasks':
      return client.listTasks({
        topicId: input.topicId,
        status: input.status,
        assignee: input.assignee,
        limit: input.limit || 50,
        cursor: input.cursor,
      });

    case 'zenzap_get_task':
      return client.getTask(input.taskId);

    case 'zenzap_get_messages':
      return client.getTopicMessages(input.topicId, {
        limit: input.limit,
        order: input.order,
        before: input.before,
        after: input.after,
        cursor: input.cursor,
      });

    case 'zenzap_react':
      return client.addReaction(input.messageId, input.reaction);

    case 'zenzap_create_task':
      return client.createTask({
        topicId: input.topicId,
        title: input.title,
        description: input.description,
        assignee: input.assignee ?? (Array.isArray(input.assignees) ? input.assignees[0] : undefined),
        dueDate: input.dueDate,
      });

    case 'zenzap_update_task': {
      if (input.name !== undefined && input.title !== undefined) {
        throw new Error('Provide either name or title, not both.');
      }
      if (
        input.name === undefined &&
        input.title === undefined &&
        input.description === undefined &&
        input.assignee === undefined &&
        input.dueDate === undefined &&
        input.status === undefined
      ) {
        throw new Error(
          'At least one field must be provided: name/title, description, assignee, dueDate, or status.',
        );
      }
      if (input.status !== undefined && !input.topicId) {
        throw new Error('topicId is required when updating task status.');
      }
      return client.updateTask(input.taskId, {
        topicId: input.topicId,
        name: input.name,
        title: input.title,
        description: input.description,
        assignee: input.assignee,
        dueDate: input.dueDate,
        status: input.status,
      });
    }

    default:
      throw new Error(`Unknown tool: ${toolId}`);
  }
}
