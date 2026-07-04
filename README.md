# Slack connector for KIAgent

Indexes your Slack workspace into your local KIAgent digital memory: every
channel, DM, and group DM you are a member of becomes searchable, kept
current by an incremental poll that also tracks active threads.

## Install

Install **Slack** from the KIAgent marketplace (Settings → Extensions →
Marketplace → Slack → Install). KIAgent will prompt for the one grant this
connector needs — `net`, so it can talk to `slack.com` — before it activates.

## Connect your workspace

Authentication is a pasted **User OAuth Token** (`xoxp-…`) from an internal
Slack app you create yourself. An internal, customer-built app keeps Slack's
standard (non-Marketplace) rate limits — never bundle OAuth; the paste-token
flow is load-bearing for backfill.

1. Go to <https://api.slack.com/apps?new_app=1> → **Create New App → From a
   manifest**, pick your workspace, and paste this manifest (read-only
   scopes):

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
- **Live sync:** afterwards it polls every **15 minutes** within a small
  request budget: stalest channels first with a ~24h re-read window (so
  replies that turn a recent message into a thread root are noticed), plus a
  pass over threads active in the last 14 days. Channels you leave (or that
  get archived/deleted) are pruned; newly joined ones are backfilled during
  the periodic membership refresh.

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
