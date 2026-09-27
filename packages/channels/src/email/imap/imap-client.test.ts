import { describe, expect, it } from 'vitest';
import { classifyImapError, ImapFailure, testImapConnection } from './imap-client.js';

describe('classifyImapError', () => {
  it('passes an ImapFailure through', () => {
    const failure = new ImapFailure('folder', 'NO such folder');
    expect(classifyImapError(failure)).toBe(failure);
  });

  it('reads a refused sign-in, keeping the server’s answer verbatim', () => {
    const failure = classifyImapError(
      Object.assign(new Error('Command failed'), {
        authenticationFailed: true,
        response: 'A1 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
      }),
    );

    expect(failure.kind).toBe('auth');
    expect(failure.serverResponse).toBe(
      'A1 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
    );
  });

  it('reads the response code alone as a refused sign-in too', () => {
    expect(classifyImapError({ serverResponseCode: 'AUTHENTICATIONFAILED' }).kind).toBe('auth');
  });

  it.each(['ETIMEOUT', 'ETIMEDOUT', 'ConnectionTimeout'])('reads %s as a timeout', (code) => {
    expect(classifyImapError(Object.assign(new Error('x'), { code })).kind).toBe('timeout');
  });

  it('reads a missing folder', () => {
    expect(classifyImapError({ serverResponseCode: 'NONEXISTENT', responseText: 'no' }).kind).toBe(
      'folder',
    );
    expect(classifyImapError(new Error("Mailbox doesn't exist: Nope")).kind).toBe('folder');
  });

  it('reads a server reply that repeats "mailbox" without slowing down', () => {
    const started = performance.now();
    expect(classifyImapError(new Error('mailbox'.repeat(50_000))).kind).toBe('connect');
    expect(classifyImapError(new Error('No such mailbox')).kind).toBe('folder');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('calls everything else a connection failure', () => {
    expect(classifyImapError(new Error('getaddrinfo ENOTFOUND imap.invalid'))).toMatchObject({
      kind: 'connect',
      serverResponse: 'getaddrinfo ENOTFOUND imap.invalid',
    });
    expect(classifyImapError('weird').serverResponse).toBeNull();
  });
});

describe('testImapConnection', () => {
  it('reports a closed port as a connection failure, within its deadline', async () => {
    await expect(
      testImapConnection(
        {
          host: '127.0.0.1',
          port: 1,
          security: 'tls',
          username: 'x',
          password: 'y',
          folder: 'INBOX',
        },
        { timeoutMs: 2_000 },
      ),
    ).rejects.toMatchObject({ name: 'ImapFailure' });
  });
});
