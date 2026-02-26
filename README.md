# @zenzap-co/openclaw-plugin

The official [Zenzap](https://zenzap.co) channel plugin for [OpenClaw](https://openclaw.ai). Connects your OpenClaw AI assistant to Zenzap so it can participate in team topics, manage tasks, and respond to messages. 

## Installation

Install the plugin using the OpenClaw CLI:

```bash
openclaw plugins install @zenzap-co/openclaw-plugin
```

Then run the setup wizard to configure your Zenzap credentials:

```bash
openclaw zenzap setup
```

The wizard will ask for your Zenzap API key and secret (or a base64 token), verify the connection, and let you pick a control topic.

Restart the gateway to activate the plugin:

```bash
openclaw gateway restart
```

## Configuration

Credentials are stored in your OpenClaw config. The setup wizard handles this automatically, but you can also configure manually:

| Field | Description |
|---|---|
| `apiKey` | Zenzap Bot API Key |
| `apiSecret` | Zenzap Bot API Secret |
| `controlTopicId` | Topic UUID for admin notifications (optional) |
| `requireMention` | Require @mention globally (default: false) |
| `pollTimeout` | Long-poll timeout in seconds (default: 20) |

## Documentation

For details on the Zenzap API and capabilities available through this plugin, see the [Zenzap documentation](https://docs.zenzap.co/api-reference/getting-started).


## License

MIT
