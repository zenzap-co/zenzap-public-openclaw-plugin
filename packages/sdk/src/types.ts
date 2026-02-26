/**
 * Zenzap API Types
 */

export type ZenzapMessageType =
  | 'text'
  | 'image'
  | 'file'
  | 'video'
  | 'audio'
  | 'location'
  | 'task'
  | 'contact';

export interface ZenzapAttachmentTranscription {
  status?: 'Pending' | 'Started' | 'Done' | 'Failed';
  text?: string;
}

export interface ZenzapAttachment {
  id?: string;
  type?: 'image' | 'file' | 'video' | 'audio';
  name?: string;
  url?: string;
  transcription?: ZenzapAttachmentTranscription;
}

export interface ZenzapLocation {
  latitude?: string;
  longitude?: string;
  name?: string;
  address?: string;
}

export interface ZenzapTaskSnapshot {
  id?: string;
  action?: 'Added' | 'Updated' | 'Deleted' | 'MarkedAsDone' | 'MarkedAsOpened' | 'Replied';
  title?: string;
  text?: string;
  status?: string;
  assignee?: string;
  dueDate?: number;
  isDueDateTimeSelected?: boolean;
  parentId?: string | null;
  subItemsCount?: number;
}

export interface ZenzapContact {
  name?: string;
  phoneNumbers?: string[];
  emails?: string[];
  role?: string;
  location?: string;
  linkedIn?: string;
  profileId?: string;
}

/**
 * Represents an inline @mention in a message.
 * The message `text` field contains widget placeholders keyed by widgetId (e.g. "w1").
 * This object maps each placeholder to the real member: widgetId → { id (profileId), name }.
 */
export interface ZenzapMention {
  /** The member's UUID (profileId) */
  id?: string;
  /** The member's display name */
  name?: string;
  /** Placeholder key that appears in the message text — look up this value in the text to find where the mention is */
  widgetId?: string;
}

export interface ZenzapMember {
  id: string;
  name: string;
  email?: string;
  type?: 'user' | 'bot';
}

export interface ZenzapTopic {
  id: string;
  name: string;
  description?: string;
  externalId?: string;
  members?: ZenzapMember[];
  createdAt?: number;
  updatedAt?: number;
}

export interface ZenzapMessage {
  id: string;
  topicId: string;
  text: string;
  senderId: string;
  senderName?: string;
  senderType?: 'user' | 'bot' | 'system';
  type?: ZenzapMessageType;
  previousText?: string;
  parentId?: string;
  mentionedProfiles?: string[];
  attachments?: ZenzapAttachment[];
  mentions?: ZenzapMention[];
  location?: ZenzapLocation;
  task?: ZenzapTaskSnapshot;
  contact?: ZenzapContact;
  truncated?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface ZenzapTask {
  id: string;
  topicId: string;
  title: string;
  description?: string;
  assignee?: string;
  assignees?: string[];
  status?: 'Open' | 'Done' | string;
  dueDate?: number;
  externalId?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ZenzapTopicMessage {
  id: string;
  topicId: string;
  senderId: string;
  senderType: 'user' | 'bot' | 'system';
  type?: ZenzapMessageType;
  text: string;
  previousText?: string;
  createdAt: number;
  updatedAt?: number;
  parentId?: string;
  isEdited?: boolean;
  isSystem?: boolean;
  mentionedProfiles?: string[];
  attachments?: ZenzapAttachment[];
  mentions?: ZenzapMention[];
  location?: ZenzapLocation;
  task?: ZenzapTaskSnapshot;
  contact?: ZenzapContact;
}

export interface ZenzapTopicMessagesResponse {
  messages: ZenzapTopicMessage[];
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface ZenzapMembersListResponse {
  members: ZenzapMember[];
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface ZenzapTopicsListResponse {
  topics: ZenzapTopic[];
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface ZenzapTasksListResponse {
  tasks: ZenzapTask[];
  nextCursor?: string | null;
  hasMore: boolean;
}

export type ZenzapEventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'reaction.added'
  | 'reaction.removed'
  | 'member.added'
  | 'member.removed'
  | 'topic.updated'
  | 'webhook.test';

export interface ZenzapMemberEventData {
  topicId: string;
  memberId?: string; // set when a single member is added/removed
  memberIds?: string[]; // all affected members
  memberType?: 'user' | 'bot';
  actorId?: string;
  memberName?: string;
  addedBy?: string;
  removedBy?: string;
  createdAt?: number;
}

export interface ZenzapTopicUpdatedEventData {
  topicId: string;
  name?: string; // set if name changed
  description?: string; // set if description changed
  changes?: { name?: string; description?: string };
  actorId?: string;
}

export interface ZenzapUpdateEvent {
  updateId: string;
  eventType: ZenzapEventType | string;
  createdAt: number;
  data: {
    // message.created / message.updated / message.deleted
    message?: ZenzapMessage;
    messageId?: string;
    updatedFields?: string[];
    deletedAt?: number;
    deletedBy?: string;
    // member.added / member.removed
    topicId?: string;
    memberId?: string;
    memberIds?: string[];
    memberType?: 'user' | 'bot';
    actorId?: string;
    // topic.updated
    name?: string;
    description?: string;
    changes?: { name?: string; description?: string };
    truncated?: boolean;
  };
}

export interface ZenzapUpdateResponse {
  updates: ZenzapUpdateEvent[];
  nextOffset: string;
}

export interface ZenzapConfig {
  apiKey: string;
  apiSecret: string;
  apiUrl?: string;
  /**
   * Timeout for remote media downloads (used by sendImageMessage imageUrl mode).
   * Defaults to 15000ms when omitted.
   */
  downloadTimeoutMs?: number;
}
