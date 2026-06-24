import { renderMrkdwn } from '../render';

const resolve = (id: string) => (id === 'U1' ? 'Alice' : id);

describe('renderMrkdwn', () => {
  it('resolves user mentions, using the inline label when present', () => {
    expect(renderMrkdwn('hi <@U1>', resolve)).toBe('hi @Alice');
    expect(renderMrkdwn('hi <@U2|bob>', resolve)).toBe('hi @bob');
  });

  it('renders channel refs and special mentions', () => {
    expect(renderMrkdwn('see <#C1|general>', resolve)).toBe('see #general');
    expect(renderMrkdwn('<!here> ping', resolve)).toBe('@here ping');
  });

  it('rewrites labeled and bare links', () => {
    expect(renderMrkdwn('<https://x.com|site>', resolve)).toBe(
      '[site](https://x.com)',
    );
    expect(renderMrkdwn('<https://x.com>', resolve)).toBe('https://x.com');
  });

  it('unescapes html entities and converts bold/strike', () => {
    expect(renderMrkdwn('a &amp; b', resolve)).toBe('a & b');
    expect(renderMrkdwn('this *is* bold', resolve)).toBe('this **is** bold');
    expect(renderMrkdwn('this ~no~ more', resolve)).toBe('this ~~no~~ more');
  });
});
