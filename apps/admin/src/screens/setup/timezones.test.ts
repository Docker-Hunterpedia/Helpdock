import { isSupportedTimeZone } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { currentTimeZone, timeZoneOptions } from './timezones.js';

describe('timeZoneOptions', () => {
  it('offers only zones the api will accept, so nothing on screen can be refused', () => {
    for (const zone of timeZoneOptions()) {
      expect(isSupportedTimeZone(zone), zone).toBe(true);
    }
  });

  it('includes UTC, which the brand column defaults to', () => {
    expect(timeZoneOptions()).toContain('UTC');
  });

  it('is sorted, because a picker of 400 names is unusable otherwise', () => {
    const options = timeZoneOptions();

    expect([...options].sort((a, b) => a.localeCompare(b, 'en'))).toEqual([...options]);
  });

  it('is built once, because 400 strings per keystroke is the cost of not doing so', () => {
    expect(timeZoneOptions()).toBe(timeZoneOptions());
  });
});

describe('currentTimeZone', () => {
  it('guesses a zone the picker actually offers', () => {
    expect(timeZoneOptions()).toContain(currentTimeZone());
  });
});
