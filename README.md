# Slack connector for alpha-cent / KIAgent

Indexes your Slack workspace into your local KIAgent digital memory: every
channel, DM, and group-DM becomes searchable, kept current by an incremental
poll that also tracks active threads.

Self-contained, out-of-process plugin — pure Node + `fetch`, no runtime npm
dependencies, no OAuth redirect. Authentication is a pasted **User OAuth token**
(`xoxp-…`) from an internal Slack app you create yourself, encrypted at rest with
the host's safeStorage.

## Host API

Requires alpha-cent host API `^2.0.0`.

## Install

This connector is published to the official `kia-plugins` marketplace. In
KIAgent:

1. Open **Add a source → Browse the marketplace** (or the Marketplace screen).
2. Find **Slack** under the official store and click **Install**.
3. Review the requested permissions (`db:read`, `db:write`, `net`, `secrets`)
   and confirm.

Then add an account:

1. Go to <https://api.slack.com/apps> → **Create New App → From a manifest** and
   paste the manifest the wizard shows you (it requests only read scopes:
   `channels`, `groups`, `im`, `mpim` history/read, `users:read`, `files:read`).
2. **Install App → Install to Workspace**, then copy the **User OAuth Token**
   (`xoxp-…`).
3. Paste the token into the connector's setup field.

An internal app keeps Slack's standard (non-Marketplace) rate limits — never
bundle OAuth; the paste-token flow is load-bearing.

### Install from a release tarball (Tier 2)

You can also install directly from a published GitHub release: paste the
release's `.tgz` URL and its integrity hash into KIAgent's "Install from URL"
dialog.

## What it indexes

- One `slack_channel_day` document per channel/DM/group-DM per local-time day.
- One `slack_thread` document per thread (root + replies), re-written as replies
  arrive.
- File attachments as `file` documents. Convertible files are rendered to
  Markdown on the first pass; unconvertible images/PDFs keep `markdown: null` so
  the host auto-enrolls them into the deep-extraction (OCR/VLM) pass. Raw bytes
  are cached locally (content-addressed under `<dataDir>/slack/media/<sha256>`)
  and re-read by the exported `makeByteSource` — no re-download from Slack.
- Metadata: channel id/name, participants, message timestamps, attachment ids.

Backfill walks every conversation you're a member of; delta polls newest-first
within a request budget, re-reading a 24h lookback so replies that turn a recent
message into a thread root are noticed, and prunes channels you've left.

## Trust model

This plugin runs in a forked Node process with the permissions you grant at
install time. It is not sandboxed at the OS level — install only connectors from
authors you trust. The source is here for audit.

## Build from source

```bash
npm install
npm run typecheck
npm test
npm run build        # → dist/index.js (self-contained CJS bundle)
npm run pack         # build + npm pack → slack-kia-connector-<version>.tgz
```

## Releasing a new version

1. Bump `version` in **both** `package.json` and `manifest.json` (must match).
2. `npm install` (if deps changed) → `npm test` → `npm run pack`.
3. Compute the integrity hash:
   ```bash
   openssl dgst -sha512 -binary slack-kia-connector-<version>.tgz \
     | { printf 'sha512-'; base64; }
   ```
4. Publish the GitHub release with the tarball as an asset:
   ```bash
   gh release create v<version> slack-kia-connector-<version>.tgz \
     --title "v<version>" --notes "Integrity: sha512-…"
   ```

## License

MIT — see [LICENSE](./LICENSE).
