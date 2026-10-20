# Slack connector for KIAgent

Indexes your Slack workspace into your local KIAgent digital memory: every
channel, DM, and group DM you are a member of becomes searchable, kept
current by an incremental poll that also tracks active threads.

## Install

Install **Slack** from the KIAgent marketplace (Settings → Extensions →
Marketplace → Slack → Install). KIAgent will prompt for the two grants this
connector needs before it activates: `net`, so it can talk to `slack.com`,
and `send`, so a reply you confirm in KIAgent can be posted back to Slack.
`send` is host-initiated only — the connector can never start a send itself.

## Connect your workspace

Authentication is a pasted **User OAuth Token** (`xoxp-…`) from an internal
Slack app you create yourself. An internal, customer-built app keeps Slack's
standard (non-Marketplace) rate limits — never bundle OAuth; the paste-token
flow is load-bearing for backfill.

1. Go to <https://api.slack.com/apps?new_app=1> → **Create New App → From a
   manifest**, pick your workspace, and paste this manifest (read scopes
   plus `chat:write`, which is used only to post replies you confirm in
   KIAgent):

   ```yaml
   display_information:
     name: KIAgent
     description: Personal digital memory indexing (runs locally on your Mac)
   oauth_config:
     scopes:
       user:
         - channels:history
         - channels:read
         - groups:history
         - groups:read
         - im:history
         - im:read
         - mpim:history
         - mpim:read
         - users:read
         - files:read
         - chat:write
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

2. On the app page: **Install App → Install to Workspace**, then copy the
   **User OAuth Token** (`xoxp-…` — NOT the Bot token `xoxb-…`).
3. In KIAgent, add a Slack account and paste the token when prompted. The
   connector verifies it (and its scopes) against Slack's `auth.test` before
   saving it into the encrypted vault, and shows your workspace name as the
   account identifier.

## What gets indexed

- One `slack.day` document per channel/DM/group-DM per local-time day.
- One `slack.thread` document per thread (root + replies), re-written as
  replies arrive.
- File attachments as `file` documents (children of their day/thread doc).
  Bytes are handed to the platform, which converts or OCRs them locally;
  files over 50 MB are indexed by metadata only.
- Metadata: channel id/name, conversation type, participants, message
  timestamps.

## Sync behavior

- **Backfill:** on first connect, the connector walks the full history of
  every conversation you're a member of, resuming page-aligned if
  interrupted — even mid-channel.
- **Live sync:** afterwards it polls every **15 minutes** within a budget
  of 80 requests (about 5 a minute, well under Slack's limit for internal
  apps). Conversations are read by how recently they were active:
  - active in the last 7 days: every poll;
  - active in the last year: hourly;
  - older, or never used: every 6 hours.

  A quiet conversation that gets a new message turns active on the next
  poll. Each read re-covers ~24h so replies that turn a recent message into
  a thread root are noticed. Threads with replies in the last 14 days are
  probed the same way: every poll when replied to within a day, hourly
  within a week, every 6 hours after that. Part of the budget is kept for
  them. Channels you leave (or that get archived/deleted) are pruned; newly
  joined ones are backfilled during the periodic membership refresh.
- **Freshness:** every poll logs how long ago the least recently read active
  conversation was read, and warns when that exceeds 30 minutes.

## Privacy

Your Slack content is fetched directly from Slack's API and written straight
into your local KIAgent index. The connector has no server of its own and no
analytics: the only network traffic it makes is between `slack.com` and your
machine, over the platform's `net` capability — nothing is sent anywhere
else. The token lives in the platform's encrypted vault, never in config or
documents.

## Build from source

```bash
npm install
npm test
npm run typecheck
npm run build        # → dist/index.js (self-contained CJS bundle)
npm pack             # → slack-kia-connector-<version>.tgz
```

## License

MIT — see [LICENSE](./LICENSE).
