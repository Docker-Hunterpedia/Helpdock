import { describe, expect, it } from 'vitest';
import { readPublicInstallInfo } from './public-info.js';

const documentWith = (head: string): Document =>
  new DOMParser().parseFromString(`<html><head>${head}</head><body></body></html>`, 'text/html');

describe('readPublicInstallInfo', () => {
  it('reads what the api rendered into the page', () => {
    const doc = documentWith(
      '<meta name="helpdock:primary-domain" content="support.helpdock.com" />' +
        '<meta name="helpdock:brand-count" content="3" />',
    );

    expect(readPublicInstallInfo(doc)).toEqual({
      primaryDomain: 'support.helpdock.com',
      brandCount: 3,
    });
  });

  it.each(['0', '-1', 'many', ''])(
    'treats %s as a single brand, so the caption never claims a count it does not have',
    (content) => {
      const doc = documentWith(`<meta name="helpdock:brand-count" content="${content}" />`);

      expect(readPublicInstallInfo(doc).brandCount).toBe(1);
    },
  );

  it('falls back to the host it is served from when the tag is missing', () => {
    expect(readPublicInstallInfo(documentWith('')).primaryDomain).toBe(location.hostname);
  });
});
