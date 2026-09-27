import type { Mailbox } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { ago, allowlistLines, healthLabelKey, looksLikeEmail } from './format.js';
import { draftFrom, isDirty, testRequest, toUpdate, validate } from './mailbox-draft.js';

const DEPARTMENT = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';

const saved: Mailbox = {
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e1',
  address: 'billing@helpdock.io',
  displayName: 'Billing',
  departmentId: DEPARTMENT,
  departmentName: 'Billing',
  method: 'imap',
  imap: {
    host: 'imap.fastmail.com',
    port: 993,
    security: 'tls',
    username: 'billing@helpdock.io',
    folder: 'INBOX',
    pollIntervalSeconds: 120,
    passwordSet: true,
    passwordUpdatedAt: null,
    passwordUpdatedByName: null,
  },
  inboundProvider: null,
  remoteImages: 'proxy',
  authFailureIsSpam: true,
  automatedAllowlist: ['alerts@statuspage.io'],
  health: {
    state: 'failing',
    lastPolledAt: null,
    lastSuccessAt: null,
    lastReceivedAt: null,
    lastError: 'NO',
    lastErrorKind: 'auth',
    lastErrorAt: null,
  },
  createdAt: '2026-09-01T09:00:00.000Z',
};

describe('the mailbox draft', () => {
  it('starts a new mailbox as IMAP with an open password field', () => {
    const draft = draftFrom(undefined, DEPARTMENT);
    expect(draft).toMatchObject({
      method: 'imap',
      port: '993',
      password: '',
      folder: 'INBOX',
      departmentId: DEPARTMENT,
    });
  });

  it('keeps a saved password out of the draft, and notices a change', () => {
    const draft = draftFrom(saved, DEPARTMENT);
    expect(draft.password).toBeNull();
    expect(draft.allowlist).toBe('alerts@statuspage.io');
    expect(isDirty(draft, draftFrom(saved, DEPARTMENT))).toBe(false);
    expect(isDirty({ ...draft, displayName: 'x' }, draft)).toBe(true);
  });

  it('refuses what cannot be sent, field by field', () => {
    const result = validate(
      { ...draftFrom(undefined, ''), address: 'nope', port: '70000', allowlist: 'not an address' },
      { creating: true },
    );

    expect(result).toEqual({
      ok: false,
      errors: {
        address: 'email',
        displayName: 'required',
        departmentId: 'required',
        allowlist: 'email',
        host: 'required',
        port: 'port',
        username: 'required',
        password: 'password',
      },
    });
    expect(
      validate({ ...draftFrom(undefined, DEPARTMENT), address: '' }, { creating: true }),
    ).toMatchObject({
      errors: { address: 'required' },
    });
  });

  it('sends a saved mailbox without its password unless one was typed', () => {
    const draft = draftFrom(saved, DEPARTMENT);
    const checked = validate(draft, { creating: false });
    if (!checked.ok) {
      throw new Error('expected a valid draft');
    }

    expect(toUpdate(checked.request, draft)).toMatchObject({
      imap: { host: 'imap.fastmail.com', pollIntervalSeconds: 120 },
    });
    expect(toUpdate(checked.request, draft)).not.toHaveProperty('imap.password');

    const replaced = { ...draft, password: 'new' };
    const withPassword = validate(replaced, { creating: false });
    expect(withPassword.ok && toUpdate(withPassword.request, replaced)).toMatchObject({
      imap: { password: 'new' },
    });
  });

  it('builds an inbound-parse request without any IMAP fields', () => {
    const checked = validate(
      {
        ...draftFrom(undefined, DEPARTMENT),
        method: 'inbound_parse',
        address: ' Hello@Helpdock.io ',
        displayName: 'Hello',
      },
      { creating: true },
    );

    expect(checked).toEqual({
      ok: true,
      request: {
        address: 'hello@helpdock.io',
        displayName: 'Hello',
        departmentId: DEPARTMENT,
        remoteImages: 'block',
        authFailureIsSpam: false,
        automatedAllowlist: [],
        method: 'inbound_parse',
      },
    });
    expect(
      toUpdate(
        checked.ok ? checked.request : (undefined as never),
        draftFrom(undefined, DEPARTMENT),
      ),
    ).toMatchObject({
      method: 'inbound_parse',
    });
  });

  it('asks Test IMAP to use the stored password when none was typed', () => {
    expect(testRequest(draftFrom(saved, DEPARTMENT), saved.id)).toEqual({
      ok: true,
      request: {
        host: 'imap.fastmail.com',
        port: 993,
        security: 'tls',
        username: 'billing@helpdock.io',
        folder: 'INBOX',
        mailboxId: saved.id,
      },
    });
    expect(testRequest(draftFrom(undefined, DEPARTMENT), undefined)).toMatchObject({
      ok: false,
      errors: { host: 'required', password: 'password' },
    });
    expect(
      testRequest({ ...draftFrom(saved, DEPARTMENT), folder: ' ', password: 'p' }, saved.id),
    ).toMatchObject({
      ok: false,
      errors: { folder: 'required' },
    });
  });
});

describe('the Channels formatting', () => {
  it('reads the allow-list a line at a time, lower-cased', () => {
    expect(allowlistLines(' A@B.co \r\n\n c@d.co ')).toEqual(['a@b.co', 'c@d.co']);
    expect(looksLikeEmail('a@b.co')).toBe(true);
    expect(looksLikeEmail('a@b')).toBe(false);
  });

  it('says how long ago, in the step that fits and with Latin digits', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    expect(ago('2026-09-27T11:59:48Z', now, 'en')).toBe('12 seconds ago');
    expect(ago('2026-09-27T11:54:00Z', now, 'en')).toBe('6 minutes ago');
    expect(ago('2026-09-27T09:00:00Z', now, 'en')).toBe('3 hours ago');
    expect(ago('2026-09-20T12:00:00Z', now, 'en')).toBe('7 days ago');
    expect(ago('2026-09-27T12:00:05Z', now, 'en')).toBe('now');
    expect(ago('2026-09-27T11:54:00Z', now, 'ar')).toMatch(/6/);
  });

  it('names a failure by what failed', () => {
    expect(healthLabelKey(saved)).toBe('channels:health.auth');
    expect(healthLabelKey({ health: { ...saved.health, lastErrorKind: null } })).toBe(
      'channels:health.failing',
    );
    expect(healthLabelKey({ health: { ...saved.health, state: 'healthy' } })).toBe(
      'channels:health.healthy',
    );
  });
});
