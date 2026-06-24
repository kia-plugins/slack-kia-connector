/**
 * Slack mrkdwn → GitHub-flavored markdown. Pure; user-id resolution injected.
 * Order matters: angle-bracket constructs first (entities can't appear inside
 * them), then entity unescape, then inline formatting.
 */
export function renderMrkdwn(
  text: string,
  resolveUser: (id: string) => string,
): string {
  let out = text;
  out = out.replace(
    /<@([A-Z0-9]+)(?:\|([^>]*))?>/g,
    (_m, id: string, label?: string) => `@${label || resolveUser(id)}`,
  );
  out = out.replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1');
  out = out.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1');
  out = out.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '[$2]($1)');
  out = out.replace(/<((?:https?|mailto):[^>]+)>/g, '$1');
  out = out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?;:])/gm, '$1**$2**');
  out = out.replace(/(^|[\s(])~([^~\n]+)~(?=$|[\s).,!?;:])/gm, '$1~~$2~~');
  return out;
}
