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
  | 'contact'
  | 'poll';

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
 * Mention tokens in message text are preserved as `<@profileId>`.
 * Use `id` (profileId) as the stable identifier for external integrations.
 */
export interface ZenzapMention {
  /** The member's UUID (profileId) */
  id?: string;
  /** The member's display name */
  name?: string;
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
  poll?: ZenzapPollSnapshot;
  truncated?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface ZenzapPollOption {
  id: string;
  text: string;
}

export interface ZenzapPoll {
  id: string;
  topicId: string;
  question: string;
  options: ZenzapPollOption[];
  selectionType: string;
  status: string;
  anonymous?: boolean;
  expiresAt?: number;
  createdAt: number;
}

/** Poll data embedded in a message event (from the poll attachment). */
export interface ZenzapPollOptionSnapshot {
  id: string;
  text: string;
}

export interface ZenzapPollSnapshot {
  /** Attachment ID — required as `attachmentId` when calling castPollVote. */
  id: string;
  title?: string;
  subtitle?: string;
  options?: ZenzapPollOptionSnapshot[];
  selectionType?: string;
  anonymous?: boolean;
  status?: string;
  expiresAt?: number;
}

export interface ZenzapPollVoteCreateResponse {
  id: string;
  attachmentId: string;
  optionId: string;
  createdAt: number;
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
  poll?: ZenzapPollSnapshot;
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
  | 'webhook.test'
  | 'poll_vote.created'
  | 'poll_vote.deleted';

export interface ZenzapPollVoteEventData {
  pollVoteId: string;
  attachmentId: string;
  messageId: string;
  topicId: string;
  optionId: string;
  voterId: string;
  createdAt: number;
}

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
    // poll_vote.created / poll_vote.deleted
    pollVoteId?: string;
    attachmentId?: string;
    optionId?: string;
    voterId?: string;
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
