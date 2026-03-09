export function getTopicConversationId(topicId: string): string {
  return `zenzap:${topicId}`;
}

export function getTopicBindingPeer(topicId: string): { kind: 'group'; id: string } {
  return { kind: 'group', id: topicId };
}
