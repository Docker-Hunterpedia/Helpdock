import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminContentSecurityPolicy, inlineScriptHashes } from './content-security-policy.js';

const sha256 = (script: string): string =>
  `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;

describe('inlineScriptHashes', () => {
  it('hashes the body of an inline script exactly as a browser would', () => {
    const body = "document.documentElement.lang = 'ar';";

    expect(inlineScriptHashes(`<html><head><script>${body}</script></head></html>`)).toEqual([
      sha256(body),
    ]);
  });

  it('skips a script that loads a file, which has no body to hash', () => {
    expect(
      inlineScriptHashes('<script type="module" src="/assets/index-Abc1.js"></script>'),
    ).toEqual([]);
  });

  it('hashes every inline script, in document order', () => {
    const html = '<script>one();</script><script src="/a.js"></script><script>two();</script>';

    expect(inlineScriptHashes(html)).toEqual([sha256('one();'), sha256('two();')]);
  });
});

describe('adminContentSecurityPolicy', () => {
  const policy = adminContentSecurityPolicy('<script>boot();</script>');
  const directive = (name: string): string =>
    policy.split('; ').find((entry) => entry.startsWith(`${name} `)) ?? '';

  it('admits the inline script by hash rather than by unsafe-inline', () => {
    expect(directive('script-src')).toBe(`script-src 'self' ${sha256('boot();')}`);
    expect(directive('script-src')).not.toContain('unsafe-inline');
  });

  it('keeps everything the SPA needs to its own origin', () => {
    expect(directive('default-src')).toBe("default-src 'none'");
    expect(directive('connect-src')).toBe("connect-src 'self'");
    expect(directive('font-src')).toBe("font-src 'self'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
  });

  it('allows inline styles, which is what Emotion writes MUI into', () => {
    expect(directive('style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });

  it('leaves no trailing space when the document has no inline script', () => {
    expect(adminContentSecurityPolicy('<html></html>')).toContain("script-src 'self';");
  });
});
