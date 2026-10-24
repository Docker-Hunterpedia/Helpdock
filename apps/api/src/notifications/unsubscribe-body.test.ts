import { describe, expect, it } from 'vitest';
import { readUnsubscribeForm, UNSUBSCRIBE_ROUTE } from './unsubscribe-body.js';

const multipart = async (build: (form: FormData) => void) => {
  const form = new FormData();
  build(form);
  const request = new Request('http://mail.test', { method: 'POST', body: form });

  return {
    contentType: request.headers.get('content-type') ?? '',
    body: Buffer.from(await request.arrayBuffer()),
  };
};

describe('UNSUBSCRIBE_ROUTE', () => {
  it('matches the token route, with or without a query, and nothing else', () => {
    expect(UNSUBSCRIBE_ROUTE.matches('/api/public/unsubscribe/:token')).toBe(true);
    expect(UNSUBSCRIBE_ROUTE.matches('/api/public/unsubscribe/abc.def')).toBe(true);
    expect(UNSUBSCRIBE_ROUTE.matches('/api/public/unsubscribe/abc.def?x=1')).toBe(true);
    expect(UNSUBSCRIBE_ROUTE.matches('/api/public/unsubscribe/')).toBe(false);
    expect(UNSUBSCRIBE_ROUTE.matches('/api/public/unsubscribe/a/b')).toBe(false);
    expect(UNSUBSCRIBE_ROUTE.matches('/x/api/public/unsubscribe/abc')).toBe(false);
  });

  it('keeps the body to a few KiB, far under the default', () => {
    expect(UNSUBSCRIBE_ROUTE.bodyLimit).toBeLessThanOrEqual(8 * 1024);
  });
});

describe('readUnsubscribeForm', () => {
  it('reads the text fields of a multipart body', async () => {
    const { body, contentType } = await multipart((form) => {
      form.append('List-Unsubscribe', 'One-Click');
    });

    expect(await readUnsubscribeForm(body, contentType)).toEqual({
      'List-Unsubscribe': 'One-Click',
    });
  });

  it('ignores a file, which is not a field', async () => {
    const { body, contentType } = await multipart((form) => {
      form.append('List-Unsubscribe', 'One-Click');
      form.append('extra', new File([new Uint8Array([1])], 'x.bin'));
    });

    expect(await readUnsubscribeForm(body, contentType)).toEqual({
      'List-Unsubscribe': 'One-Click',
    });
  });

  it('gives no fields for bytes that are not the multipart they claim to be', async () => {
    expect(await readUnsubscribeForm(Buffer.from('garbage'), 'multipart/form-data')).toEqual({});
  });

  it('passes through what the url-encoded and JSON parsers already made', async () => {
    const parsed = { 'List-Unsubscribe': 'One-Click' };

    expect(await readUnsubscribeForm(parsed, 'application/x-www-form-urlencoded')).toBe(parsed);
    expect(await readUnsubscribeForm(undefined, undefined)).toBeUndefined();
  });
});
