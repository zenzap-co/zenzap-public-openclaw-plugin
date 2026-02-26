import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    createTask: vi.fn(),
    updateTask: vi.fn(),
    sendImageMessage: vi.fn(),
    listMembers: vi.fn(),
    listTopics: vi.fn(),
    listTasks: vi.fn(),
    getTask: vi.fn(),
  },
}));

vi.mock('@zenzap-co/sdk', () => ({
  getClient: () => mockClient,
}));

import { executeTool } from '../tools.js';

describe('executeTool task operations', () => {
  beforeEach(() => {
    mockClient.createTask.mockReset();
    mockClient.updateTask.mockReset();
    mockClient.sendImageMessage.mockReset();
    mockClient.listMembers.mockReset();
    mockClient.listTopics.mockReset();
    mockClient.listTasks.mockReset();
    mockClient.getTask.mockReset();
    mockClient.createTask.mockResolvedValue({ id: 'task-1' });
    mockClient.updateTask.mockResolvedValue({ id: 'task-1', updatedAt: 1 });
    mockClient.sendImageMessage.mockResolvedValue({ id: 'msg-1' });
    mockClient.listMembers.mockResolvedValue({ members: [], hasMore: false });
    mockClient.listTopics.mockResolvedValue({ topics: [], hasMore: false });
    mockClient.listTasks.mockResolvedValue({ tasks: [], hasMore: false });
    mockClient.getTask.mockResolvedValue({ id: 'task-1' });
  });

  it('maps deprecated assignees[] to assignee for create_task', async () => {
    await executeTool('zenzap_create_task', {
      topicId: 'topic-1',
      title: 'Review docs',
      assignees: ['user-1', 'user-2'],
    });

    expect(mockClient.createTask).toHaveBeenCalledWith({
      topicId: 'topic-1',
      title: 'Review docs',
      description: undefined,
      assignee: 'user-1',
      dueDate: undefined,
    });
  });

  it('updates task status when topicId is provided', async () => {
    await executeTool('zenzap_update_task', {
      taskId: 'task-1',
      topicId: 'topic-1',
      status: 'Done',
    });

    expect(mockClient.updateTask).toHaveBeenCalledWith('task-1', {
      topicId: 'topic-1',
      name: undefined,
      title: undefined,
      description: undefined,
      assignee: undefined,
      dueDate: undefined,
      status: 'Done',
    });
  });

  it('rejects update_task with no mutable fields', async () => {
    await expect(
      executeTool('zenzap_update_task', { taskId: 'task-1' }),
    ).rejects.toThrow('At least one field must be provided');
  });

  it('updates task due date and allows clearing with zero', async () => {
    await executeTool('zenzap_update_task', {
      taskId: 'task-1',
      dueDate: 0,
    });

    expect(mockClient.updateTask).toHaveBeenCalledWith('task-1', {
      topicId: undefined,
      name: undefined,
      title: undefined,
      description: undefined,
      assignee: undefined,
      dueDate: 0,
      status: undefined,
    });
  });

  it('requires topicId when updating status', async () => {
    await expect(
      executeTool('zenzap_update_task', { taskId: 'task-1', status: 'Done' }),
    ).rejects.toThrow('topicId is required when updating task status');
  });

  it('sends image message using URL upload tool', async () => {
    await executeTool('zenzap_send_image', {
      topicId: 'topic-1',
      imageUrl: 'https://example.com/chart.png',
      caption: 'Latest chart',
      externalId: 'img-1',
      fileName: 'chart.png',
    });

    expect(mockClient.sendImageMessage).toHaveBeenCalledWith({
      topicId: 'topic-1',
      imageUrl: 'https://example.com/chart.png',
      caption: 'Latest chart',
      externalId: 'img-1',
      fileName: 'chart.png',
    });
  });

  it('sends image message using base64 payload', async () => {
    await executeTool('zenzap_send_image', {
      topicId: 'topic-1',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO1Xw6QAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      caption: 'Generated',
      fileName: 'generated.png',
    });

    expect(mockClient.sendImageMessage).toHaveBeenCalledWith({
      topicId: 'topic-1',
      imageUrl: undefined,
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO1Xw6QAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      caption: 'Generated',
      externalId: undefined,
      fileName: 'generated.png',
    });
  });

  it('rejects send_image when both imageUrl and imageBase64 are provided', async () => {
    await expect(
      executeTool('zenzap_send_image', {
        topicId: 'topic-1',
        imageUrl: 'https://example.com/chart.png',
        imageBase64: 'Zm9v',
      }),
    ).rejects.toThrow('Provide exactly one of imageUrl or imageBase64');
  });

  it('rejects send_image when neither imageUrl nor imageBase64 is provided', async () => {
    await expect(
      executeTool('zenzap_send_image', {
        topicId: 'topic-1',
      }),
    ).rejects.toThrow('Provide exactly one of imageUrl or imageBase64');
  });

  it('lists members using cursor pagination and emails filter', async () => {
    await executeTool('zenzap_list_members', {
      limit: 25,
      cursor: 'cursor-1',
      emails: ['a@example.com', 'b@example.com'],
    });

    expect(mockClient.listMembers).toHaveBeenCalledWith({
      limit: 25,
      cursor: 'cursor-1',
      emails: ['a@example.com', 'b@example.com'],
    });
  });

  it('supports deprecated email filter alias for list_members', async () => {
    await executeTool('zenzap_list_members', {
      limit: 10,
      email: 'single@example.com',
    });

    expect(mockClient.listMembers).toHaveBeenCalledWith({
      limit: 10,
      cursor: undefined,
      emails: 'single@example.com',
    });
  });

  it('lists topics using cursor pagination', async () => {
    await executeTool('zenzap_list_topics', {
      limit: 30,
      cursor: 'topics-cursor',
    });

    expect(mockClient.listTopics).toHaveBeenCalledWith({
      limit: 30,
      cursor: 'topics-cursor',
    });
  });

  it('lists tasks with optional filters', async () => {
    await executeTool('zenzap_list_tasks', {
      topicId: 'topic-1',
      status: 'Open',
      assignee: 'user-1',
      limit: 20,
      cursor: 'tasks-cursor',
    });

    expect(mockClient.listTasks).toHaveBeenCalledWith({
      topicId: 'topic-1',
      status: 'Open',
      assignee: 'user-1',
      limit: 20,
      cursor: 'tasks-cursor',
    });
  });

  it('gets task details by taskId', async () => {
    await executeTool('zenzap_get_task', { taskId: 'task-1' });
    expect(mockClient.getTask).toHaveBeenCalledWith('task-1');
  });
});
