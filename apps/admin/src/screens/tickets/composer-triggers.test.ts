import { describe, expect, it } from 'vitest';
import { detectTrigger, replaceRange, replaceTrigger } from './composer-triggers.js';

const reply = { slash: true };
const note = { slash: false };

describe('detectTrigger: the slash', () => {
  it.each([
    ['/', 1, ''],
    ['/ref', 4, 'ref'],
    ['Hi Mona, /ref', 13, 'ref'],
    ['Thanks.\n/refund', 15, 'refund'],
    ['Hi\t/x', 5, 'x'],
    ['/استرجاع', 8, 'استرجاع'],
    ['/q3-fees_2', 10, 'q3-fees_2'],
  ])('opens for %j with the caret at %i', (text, caret, query) => {
    expect(detectTrigger(text, caret, reply)).toEqual({
      kind: 'slash',
      start: caret - query.length - 1,
      end: caret,
      query,
    });
  });

  it.each([
    ['https://example.com/ref', 23],
    ['and/or', 6],
    ['a/b', 3],
    ['see /ref and', 12],
    ['path /a/b', 9],
  ])('leaves a / that is part of %j alone', (text, caret) => {
    expect(detectTrigger(text, caret, reply)).toBeNull();
  });

  it('reads the word up to the caret, and is over once the caret is past the word', () => {
    expect(detectTrigger('Hi /refund', 5, reply)).toEqual({
      kind: 'slash',
      start: 3,
      end: 5,
      query: 'r',
    });
    expect(detectTrigger('Hi /refund and more', 19, reply)).toBeNull();
  });

  it('does not open in a note', () => {
    expect(detectTrigger('/ref', 4, note)).toBeNull();
  });
});

describe('detectTrigger: the braces', () => {
  it('opens for {{ and the start of a name, in a reply or a note', () => {
    expect(detectTrigger('Hi {{', 5, reply)).toEqual({
      kind: 'placeholder',
      start: 3,
      end: 5,
      query: '',
    });
    expect(detectTrigger('Hi {{cont', 9, note)).toMatchObject({
      kind: 'placeholder',
      query: 'cont',
    });
  });

  it('is over once the placeholder is closed', () => {
    expect(detectTrigger('Hi {{contact.name}}', 19, reply)).toBeNull();
  });

  it('takes precedence over a slash earlier in the text', () => {
    expect(detectTrigger('/refund {{', 10, reply)).toMatchObject({ kind: 'placeholder' });
  });
});

describe('detectTrigger: the @ (M14-15)', () => {
  const noteOptions = { slash: false, mention: true };

  it.each([
    ['@', 1, ''],
    ['Can you confirm? @om', 20, 'om'],
    ['line one\n@lina.had', 18, 'lina.had'],
    ['(@عمر', 5, 'عمر'],
  ])('opens in a note for %j', (text, caret, query) => {
    expect(detectTrigger(text, caret, noteOptions)).toEqual({
      kind: 'mention',
      start: caret - query.length - 1,
      end: caret,
      query,
    });
  });

  it.each([
    ['write to lina@example.com', 25],
    ['a.@x', 4],
    ['done @lina.haddad please', 24],
  ])('leaves %j alone', (text, caret) => {
    expect(detectTrigger(text, caret, noteOptions)).toBeNull();
  });

  it('never opens in a public reply', () => {
    expect(detectTrigger('@om', 3, { slash: true })).toBeNull();
    expect(detectTrigger('@om', 3, { slash: true, mention: false })).toBeNull();
  });
});

describe('replaceRange and replaceTrigger', () => {
  it('puts the text in place and the caret after it', () => {
    expect(replaceRange('Hi /ref bye', 3, 7, 'Refund')).toEqual({
      text: 'Hi Refund bye',
      caret: 9,
    });
  });

  it('uses the range when it still holds the word', () => {
    expect(replaceTrigger('Hi /ref', { start: 3, end: 7 }, '/ref', 'Refund')).toEqual({
      text: 'Hi Refund',
      caret: 9,
    });
  });

  it('finds the word when the text moved on', () => {
    expect(replaceTrigger('Oh, Hi /ref', { start: 3, end: 7 }, '/ref', 'Refund').text).toBe(
      'Oh, Hi Refund',
    );
  });

  it('adds the reply after what was typed when the word is gone', () => {
    expect(replaceTrigger('Typed instead', { start: 0, end: 4 }, '/ref', 'Refund')).toEqual({
      text: 'Typed instead\n\nRefund',
      caret: 21,
    });
    expect(replaceTrigger('  ', { start: 0, end: 4 }, '/ref', 'Refund').text).toBe('Refund');
  });
});
