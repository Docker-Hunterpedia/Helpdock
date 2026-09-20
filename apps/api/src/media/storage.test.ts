import { describe, expect, it } from 'vitest';
import { contentDisposition, PRESIGN_TTL_SECONDS } from './storage.js';

describe('contentDisposition', () => {
  it('offers a download by default', () => {
    expect(contentDisposition('report.pdf', false)).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('renders inline when the caller says so', () => {
    expect(contentDisposition('shot.webp', true).startsWith('inline;')).toBe(true);
  });

  it('cannot be closed early by a quote or a backslash in the name', () => {
    // Both forms are emitted, so the quoted one must not be escapable: a name
    // carrying `"` would otherwise end the parameter and start another.
    const header = contentDisposition('a"; filename="evil.html', false);

    expect(header).toBe(
      `attachment; filename="a_; filename=_evil.html"; filename*=UTF-8''a%22%3B%20filename%3D%22evil.html`,
    );
    expect(header.split('filename=')).toHaveLength(3);
  });

  it('cannot be continued onto a second header by a newline in the name', () => {
    const header = contentDisposition('a\r\nX-Evil: 1', false);

    expect(header).not.toContain('\n');
    expect(header).not.toContain('\r');
  });

  it('keeps a non-ASCII name readable through the RFC 5987 form', () => {
    const header = contentDisposition('تقرير.pdf', false);

    // The ASCII form is folded so an old client gets something; the encoded
    // form is what every current browser reads.
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('تقرير.pdf')}`);
    expect(header).toContain(`filename="${'_'.repeat(5)}.pdf"`);
  });
});

describe('the presign window', () => {
  it('is the five minutes DOMAIN-RULES §4.5 fixes', () => {
    expect(PRESIGN_TTL_SECONDS).toBe(300);
  });
});
