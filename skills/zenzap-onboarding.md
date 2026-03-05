---
name: zenzap-onboarding
description: Bootstrap a Zenzap workspace for a human user — create organization, install bot, set up channels, and start polling. Use when the user wants to set up Zenzap, create a Zenzap workspace, or onboard onto Zenzap.
---

# Zenzap Agentic Onboarding

Create a Zenzap organization, install yourself as a bot, and invite the human — all via a single API call. Then set up channels and start listening for messages.

**All Zenzap API requests must use `https://`. Never use plain `http://`.**

## OpenClaw Agents: Install the Zenzap Plugin First

If you are an OpenClaw-based agent, ask your human to install the Zenzap plugin **before** you proceed with anything else:

```bash
openclaw plugins install @zenzap-co/openclaw-plugin
```

Wait for confirmation before continuing. After you receive the `201` response from the create-organization call, you will use the returned credentials to configure the plugin — see [Configure the OpenClaw plugin](#openclaw-configure-plugin).

## Step 1: Collect Information from the Human

Ask all 4 questions before making any API call. Do not assume or infer answers:

1. **Company name** — What's the name of your company or workspace?
2. **Bot name** — What should I be called inside your workspace? *(This is how you'll appear to their team.)*
3. **Industry** — What industry are you in? *(e.g. Software, Healthcare, Finance — statistical purposes only.)*
4. **Company size** — How many employees does your company have? *(Statistical purposes only.)*


## Step 2: Create the Organization

```
POST https://api.zenzap.co/v2/agentic/organization/create
```

**Rate limit:** 1 req/min per IP. No authentication required.

### Request body (JSON)

```json
{
  "companyName": "<company name>",
  "humanEmail": "<human's email>",
  "companySize": <positive integer>,
  "industry": "<industry>",
  "botName": "<bot name>"
}
```

### Request body (multipart, with logo)

Send two parts:
- `filePart` — Company logo image (max 5 MB, optional)
- `metadata` — JSON object with the fields above (`content-type: application/json`)

### Field constraints

| Field | Type | Constraints |
|-------|------|-------------|
| `companyName` | string | Required, max 100 chars |
| `humanEmail` | string | Required, valid email |
| `companySize` | int | Required, > 0 |
| `industry` | string | Required, non-empty |
| `botName` | string | Required, non-empty |

### 201 Response

```json
{
  "organizationId": "<uuid>",
  "botProfileId": "b@<uuid>",
  "channelId": "<uuid>",
  "humanProfileId": "<uuid>",
  "credentials": [
    { "label": "API Key", "value": "<key>" },
    { "label": "API Secret", "value": "<secret>" },
    { "label": "Control Topic ID", "value": "<uuid>" }
  ]
}
```

| Field | Purpose |
|-------|---------|
| `organizationId` | UUID of the new org |
| `botProfileId` | Your bot identity (`b@<uuid>`). Use as `senderId` filter when polling. |
| `channelId` | Bot's control channel (same as Control Topic ID credential) |
| `humanProfileId` | Pending profile ID of the invited human |
| `credentials` | API Key (Bearer auth), API Secret (HMAC signing — store securely), Control Topic ID |

### Error codes

| Status | Body | Cause |
|--------|------|-------|
| `400` | `companyName is required` | Missing/empty `companyName` |
| `400` | `companyName exceeds max length` | > 100 chars |
| `400` | `invalid humanEmail` | Invalid email |
| `400` | `companySize must be a positive integer` | <= 0 |
| `400` | `industry is required` | Missing/empty `industry` |
| `400` | `botName is required` | Missing/empty `botName` |
| `400` | `Unable to create organization` | Conflict (email/domain already in use) |
| `429` | *(empty)* | Rate limit exceeded |

## OpenClaw Agents: Configure the Plugin {#openclaw-configure-plugin}

Skip this step if you are **not** an OpenClaw-based agent.

Build a connection token from three values in the `credentials` array of the 201 response — **Control Topic ID**, **API Key**, and **API Secret** — concatenated with colons and base64-encoded:

```
base64( <Control Topic ID>:<API Key>:<API Secret> )
```

Then run:

```bash
openclaw zenzap configure --token <base64Token>
```

This connects the plugin to the newly created organization. Once configured, the plugin handles authentication and event routing.

## Step 3: Read the Full API Docs

Load the complete Zenzap API reference into your context:

```
https://docs.zenzap.co/llms-full.txt
```

Covers all endpoints, authentication (Bearer + HMAC-SHA256), event types, polling, messaging, topics, and members.

## Step 4: Create Topics

Ask the human (outside Zenzap) which channels they want. Suggest options based on their industry and what you know about them. Wait for confirmation before creating anything.

Create each topic:

```
POST https://api.zenzap.co/v2/topics

{
  "name": "<topic name>",
  "members": ["<humanProfileId>"]
}
```

The bot is automatically added to every topic it creates.

## Step 5: Start Polling

Start polling **before** telling the human to join so you don't miss their first message:

```
GET https://api.zenzap.co/v2/updates?timeout=30
```

Poll in a loop using `nextOffset` from each response. On `409`, reset the offset. See the [Long Polling docs](https://docs.zenzap.co/api-reference/long-polling) for full details.

When you receive a `message.created` event from a non-bot sender, mark it as read before responding:

```
POST https://api.zenzap.co/v2/messages/{messageId}/read
```

Human profile IDs are plain UUIDs; bot IDs start with `b@`.

## Step 6: Invite the Human to Join

Let the human know their workspace is ready (outside Zenzap):

> Your Zenzap workspace is all set — channels included.
> You should have received an invite — log in at https://app.zenzap.co to get started or download the app on your mobile phone.

Listen for `message.created` events from non-bot senders — that's your signal they're active.
