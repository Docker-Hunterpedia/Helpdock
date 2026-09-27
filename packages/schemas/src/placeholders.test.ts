import { describe, expect, it } from 'vitest';
import { renderSegments, renderTemplate } from './placeholders.js';

const values = new Map([
  ['contact.first_name', 'Mona'],
  ['ticket.number', 'HD-1042'],
]);

describe('renderSegments', () => {
  it('keeps the runs that came from a placeholder apart, so a screen can mark them', () => {
    expect(renderSegments('Hi {{contact.first_name}}, about {{ticket.number}}.', values)).toEqual({
      segments: [
        { text: 'Hi ', placeholder: null },
        { text: 'Mona', placeholder: 'contact.first_name' },
        { text: ', about ', placeholder: null },
        { text: 'HD-1042', placeholder: 'ticket.number' },
        { text: '.', placeholder: null },
      ],
      unknown: [],
    });
  });

  it('leaves an unknown placeholder as written, unmarked, and reports it', () => {
    expect(renderSegments('{{contcat.name}}', values)).toEqual({
      segments: [{ text: '{{contcat.name}}', placeholder: null }],
      unknown: ['contcat.name'],
    });
  });

  it('answers text with no placeholders as one run', () => {
    expect(renderSegments('Thanks!', values).segments).toEqual([
      { text: 'Thanks!', placeholder: null },
    ]);
  });
});

describe('renderTemplate', () => {
  it('is the segments joined', () => {
    expect(renderTemplate('Re: {{ticket.number}}', values)).toEqual({
      text: 'Re: HD-1042',
      unknown: [],
    });
  });
});
