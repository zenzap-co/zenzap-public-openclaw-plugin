export function getTopicConversationId(topicId: string): string {
  return `zenzap:${topicId}`;
}

export function getTopicBindingPeer(topicId: string): { kind: 'group'; id: string } {
  return { kind: 'group', id: topicId };
}

export function parseTopicTarget(raw: string | undefined | null): string | undefined {
  let value = raw?.trim();
  if (!value) return undefined;
  if (value.startsWith('channel:')) value = value.slice('channel:'.length).trim();
  if (value.startsWith('zenzap:')) value = value.slice('zenzap:'.length).trim();
  return value || undefined;
}

export function resolveTopicIdFromOrigin(params: {
  threadId?: string | number | null;
  to?: string | null;
}): string | undefined {
  const threadId =
    params.threadId != null && String(params.threadId).trim()
      ? String(params.threadId).trim()
      : undefined;
  if (threadId) return threadId;
  return parseTopicTarget(params.to);
}
