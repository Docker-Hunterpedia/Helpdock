import { describe, expect, it } from 'vitest';
import { isTyping, shortcutFor } from './keyboard.js';

const element = (tag: string, contentEditable = false): HTMLElement => {
  const node = document.createElement(tag);
  if (contentEditable) {
    node.contentEditable = 'true';
  }

  return node;
};

describe('isTyping', () => {
  it.each(['input', 'textarea', 'select'])('is true inside a %s', (tag) => {
    expect(isTyping(element(tag))).toBe(true);
  });

  it('is true inside a rich-text area', () => {
    expect(isTyping(element('div', true))).toBe(true);
  });

  it('is false on the page itself', () => {
    expect(isTyping(element('div'))).toBe(false);
    expect(isTyping(null)).toBe(false);
    expect(isTyping(undefined)).toBe(false);
  });
});

describe('shortcutFor', () => {
  it('moves through the list with j and k', () => {
    expect(shortcutFor({ key: 'j' })).toBe('next');
    expect(shortcutFor({ key: 'k' })).toBe('previous');
  });

  it('opens the composer with r and n', () => {
    expect(shortcutFor({ key: 'r' })).toBe('reply');
    expect(shortcutFor({ key: 'n' })).toBe('note');
  });

  it('answers a capital the same way', () => {
    expect(shortcutFor({ key: 'R' })).toBe('reply');
  });

  it('ignores a letter while somebody is writing', () => {
    expect(shortcutFor({ key: 'r', target: element('textarea') })).toBeNull();
  });

  it('leaves the browser’s own chords alone', () => {
    expect(shortcutFor({ key: 'r', metaKey: true })).toBeNull();
    expect(shortcutFor({ key: 'r', ctrlKey: true })).toBeNull();
    expect(shortcutFor({ key: 'r', altKey: true })).toBeNull();
  });

  it('answers Escape even from inside a field, because that is what it is for', () => {
    expect(shortcutFor({ key: 'Escape', target: element('textarea') })).toBe('dismiss');
    expect(shortcutFor({ key: 'Escape', metaKey: true })).toBe('dismiss');
  });

  it('has nothing to say about any other key', () => {
    expect(shortcutFor({ key: 'q' })).toBeNull();
    expect(shortcutFor({ key: 'Enter' })).toBeNull();
  });
});
