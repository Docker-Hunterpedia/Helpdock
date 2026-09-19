import { describe, expect, it } from 'vitest';
import { readPublicInstallInfo } from './public-info.js';

const documentWith = (head: string): Document =>
  new DOMParser().parseFromString(`<html><head>${head}</head><body></body></html>`, 'text/html');

describe('readPublicInstallInfo', () => {
  it('reads what the api rendered into the page', () => {
    const doc = documentWith(
      '<meta name="helpdock:primary-domain" content="support.helpdock.com" />' +
        '<meta name="helpdock:brand-count" content="3" />' +
        '<meta name="helpdock:install-state" content="fresh" />' +
        '<meta name="helpdock:version" content="1.2.3" />',
    );

    expect(readPublicInstallInfo(doc)).toEqual({
      primaryDomain: 'support.helpdock.com',
      brandCount: 3,
      installState: 'fresh',
      version: '1.2.3',
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

  it.each(['', 'half', 'FRESH'])(
    'treats an install state of %j as configured, never as an install to claim',
    (content) => {
      const doc = documentWith(`<meta name="helpdock:install-state" content="${content}" />`);

      // A build served from somewhere else, or a tag a proxy stripped, must
      // land on sign-in rather than offer to create an owner.
      expect(readPublicInstallInfo(doc).installState).toBe('configured');
    },
  );

  it('reports no version rather than a wrong one when the tag is missing', () => {
    expect(readPublicInstallInfo(documentWith('')).version).toBe('');
  });
});
