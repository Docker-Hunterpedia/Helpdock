import { describe, expect, it } from 'vitest';
import { splitTitle, summarise } from './guides.ts';

describe('splitTitle', () => {
  it('takes the h1 off the body so the page has one h1', () => {
    expect(splitTitle('# Email: receiving mail\n\nHow a brand receives mail.\n', 'email')).toEqual({
      title: 'Email: receiving mail',
      body: '\nHow a brand receives mail.\n',
    });
  });

  it('falls back to the file name when the guide has no h1', () => {
    expect(splitTitle('Text only.', 'notes')).toEqual({ title: 'notes', body: 'Text only.' });
  });
});

describe('summarise', () => {
  it('turns the first paragraph into plain text without plan citations', () => {
    expect(
      summarise(
        '\nTickets of one brand, for an integration (M8-01, [REQUIREMENTS §4.11](../planning/REQUIREMENTS.md)). Outbound events are in [Webhooks](webhooks.md).\n\n## Next',
      ),
    ).toBe('Tickets of one brand, for an integration. Outbound events are in Webhooks.');
  });

  it('drops a sentence that only says which plan sections specify the guide', () => {
    expect(
      summarise(
        'How staff sign in. Specified by [REQUIREMENTS §5.1](x.md), [ARCHITECTURE §7](y.md) and DOMAIN-RULES §2.',
      ),
    ).toBe('How staff sign in.');
  });

  it('skips comments, headings and lists to find the first paragraph', () => {
    expect(summarise('<!-- generated -->\n\n## Heading\n\n- item\n\nThe `real` one.')).toBe(
      'The real one.',
    );
  });

  it('leaves no comment opener behind from nested or unterminated comments', () => {
    // One pass turns `<!<!-- x -->-- y -->` into a new `<!-- y -->`; the loop removes that too.
    expect(summarise('<!<!-- x -->-- y -->\n\nKept text.\n\n<!-- open')).toBe('Kept text.');
    expect(summarise('Text <!-- never closed')).toBe('Text');
  });

  it('cuts a long paragraph at a word and marks the cut', () => {
    const text = `${'word '.repeat(60)}end.`;
    const summary = summarise(text, 40);
    expect(summary.length).toBeLessThanOrEqual(40);
    expect(summary.endsWith('…')).toBe(true);
  });
});
