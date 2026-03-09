import { describe, expect, it, vi } from 'vitest';
import plugin from '../index.js';

describe('Zenzap channel multi-account config', () => {
  it('advertises topic-bound ACP bindings via thread capabilities and config', () => {
    const registerChannel = vi.fn();
    plugin.register({
      config: {},
      registerChannel,
      registerTool: vi.fn(),
      registerService: vi.fn(),
      registerCommand: vi.fn(),
      registerCli: vi.fn(),
      runtime: {},
    });

    const channelPlugin = registerChannel.mock.calls[0][0].plugin;
    const cfg = {
      channels: {
        zenzap: {
          enabled: true,
          accounts: {
            'agent-a': {
              apiKey: 'key-a',
              apiSecret: 'secret-a',
              threadBindings: { enabled: true, spawnAcpSessions: true },
            },
          },
        },
      },
    };

    expect(channelPlugin.capabilities.threads).toBe(true);
    expect(
      channelPlugin.configSchema.jsonSchema.properties.threadBindings.properties.spawnAcpSessions.type,
    ).toBe('boolean');
    expect(channelPlugin.config.resolveAccount(cfg, 'agent-a')).toMatchObject({
      accountId: 'agent-a',
      config: {
        threadBindings: {
          enabled: true,
          spawnAcpSessions: true,
        },
      },
    });
  });

  it('lists named accounts and resolves their configs', () => {
    const registerChannel = vi.fn();
    plugin.register({
      config: {},
      registerChannel,
      registerTool: vi.fn(),
      registerService: vi.fn(),
      registerCommand: vi.fn(),
      registerCli: vi.fn(),
      runtime: {},
    });

    const channelPlugin = registerChannel.mock.calls[0][0].plugin;
    const cfg = {
      channels: {
        zenzap: {
          enabled: true,
          accounts: {
            'agent-a': { apiKey: 'key-a', apiSecret: 'secret-a', controlTopicId: '550e8400-e29b-41d4-a716-446655440001' },
            'agent-b': { apiKey: 'key-b', apiSecret: 'secret-b' },
          },
        },
      },
    };

    expect(channelPlugin.config.listAccountIds(cfg)).toEqual(['agent-a', 'agent-b']);
    expect(channelPlugin.config.resolveAccount(cfg, 'agent-a')).toMatchObject({
      accountId: 'agent-a',
      enabled: true,
      config: {
        accountId: 'agent-a',
        apiKey: 'key-a',
        apiSecret: 'secret-a',
      },
    });
  });

  it('keeps legacy single-account config as the default account', () => {
    const registerChannel = vi.fn();
    plugin.register({
      config: {},
      registerChannel,
      registerTool: vi.fn(),
      registerService: vi.fn(),
      registerCommand: vi.fn(),
      registerCli: vi.fn(),
      runtime: {},
    });

    const channelPlugin = registerChannel.mock.calls[0][0].plugin;
    const cfg = {
      channels: {
        zenzap: {
          enabled: true,
          apiKey: 'legacy-key',
          apiSecret: 'legacy-secret',
        },
      },
    };

    expect(channelPlugin.config.listAccountIds(cfg)).toEqual(['default']);
    expect(channelPlugin.config.resolveAccount(cfg, 'default')).toMatchObject({
      accountId: 'default',
      enabled: true,
      config: {
        accountId: 'default',
        apiKey: 'legacy-key',
        apiSecret: 'legacy-secret',
      },
    });
  });
});
