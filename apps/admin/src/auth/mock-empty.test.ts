import { afterEach, describe, expect, it } from 'vitest';
import { isMockEmpty, MOCK_EMPTY_STORAGE } from './mock-empty.js';

afterEach(() => {
  window.localStorage.clear();
});

describe('isMockEmpty', () => {
  it('is false when nothing is seeded', () => {
    expect(isMockEmpty('contacts')).toBe(false);
  });

  it('is true only for the listed areas', () => {
    window.localStorage.setItem(MOCK_EMPTY_STORAGE, JSON.stringify(['contacts', 'rules']));

    expect(isMockEmpty('contacts')).toBe(true);
    expect(isMockEmpty('rules')).toBe(true);
    expect(isMockEmpty('macros')).toBe(false);
  });

  it('ignores a value that is not a JSON array', () => {
    window.localStorage.setItem(MOCK_EMPTY_STORAGE, 'contacts');
    expect(isMockEmpty('contacts')).toBe(false);

    window.localStorage.setItem(MOCK_EMPTY_STORAGE, '{"contacts":true}');
    expect(isMockEmpty('contacts')).toBe(false);
  });
});
