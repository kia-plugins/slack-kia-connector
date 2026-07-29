/**
 * Slack Sender — chat.postMessage into the channel/thread the source doc
 * came from. Reply-only by design: the ref is the opaque metadata.outbound
 * the host round-trips verbatim; this module never receives a free-form
 * recipient. Reachable only from the host's confirmation-gated send
 * pipeline.
 */
import type {
  HostFor,
  SendIntent,
  SendResult,
  Sender,
  SenderContext,
} from '@kiagent/connector-sdk';
import {
  SlackApiError,
  SlackClient,
  isAuthError,
  type NetFetch,
  type SlackEnvelope,
} from './client';

/** metadata.outbound.ref as messages.ts writes it — channel always, thread_ts
 *  only on thread documents (a day document replies at channel level). */
interface OutboundRef {
  channel?: string;
  thread_ts?: string;
}

interface PostMessageResponse extends SlackEnvelope {
  ts?: string;
}

export function createSlackSender(host: HostFor<'net' | 'send'>): Sender {
  return {
    async send(intent: SendIntent, ctx?: SenderContext): Promise<SendResult> {
      // The xoxp token lives host-side in the vault; a Sender runs
      // out-of-process and gets it handed in at send time.
      const token = ctx?.credentials?.password;
      if (!token)
        throw new Error('no Slack credentials — reconnect the account in Settings');
      const ref = (intent.outboundRef ?? {}) as OutboundRef;
      const channel = ref.channel;
      if (!channel)
        throw new Error(
          'this Slack draft has no reply target — draft from a fresher document (older docs gain reply targets on their next sync)',
        );
      const client = new SlackClient({
        fetch: host.net.fetch as NetFetch,
        token,
        // A send is NOT idempotent: chat.postMessage has no idempotency key,
        // so retrying a network failure that happened AFTER Slack accepted
        // the write would post the message twice. Fail loud instead — the
        // user can re-confirm. (429s still retry: Slack rejects those before
        // processing, so they cannot duplicate.)
        maxTransientRetries: 0,
      });
      try {
        const r = await client.call<PostMessageResponse>('chat.postMessage', {
          channel,
          // Params drops undefined values — a day doc posts at channel level
          // with no thread_ts key at all.
          thread_ts: ref.thread_ts,
          text: intent.bodyMarkdown,
        });
        return { externalMessageId: r.ts };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The token predates chat:write (or the app was never re-installed) —
        // a re-consent, not a transport failure.
        if (/missing_scope/i.test(msg))
          throw new Error(
            'your Slack app token lacks chat:write — re-create the app from the README manifest, reinstall it to the workspace, then reconnect the account in Settings',
          );
        // The other five AUTH_ERROR_CODES (invalid_auth, account_inactive,
        // token_revoked, token_expired, not_authed) are equally provable
        // PRE-delivery rejections — say so in words core classifies as auth,
        // or the app renders "may still have been sent" with no Try again.
        if (isAuthError(e))
          throw new Error(
            `your Slack token no longer works${
              e instanceof SlackApiError ? ` (${e.slackError})` : ''
            } — reconnect the account in Settings`,
          );
        throw e;
      }
    },
  };
}
