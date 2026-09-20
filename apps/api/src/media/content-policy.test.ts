import { DEFAULT_CONTENT_POLICY } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { checkUpload, PolicyRefusal, readContentPolicy } from './content-policy.js';

const MIB = 1_048_576;

const refusal = (run: () => unknown): PolicyRefusal => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyRefusal);
    return error as PolicyRefusal;
  }
  throw new Error('expected the policy to refuse that upload');
};

describe('readContentPolicy', () => {
  it('reads a stored policy', () => {
    const policy = readContentPolicy({ keepOriginals: true, maxAttachmentsPerMessage: 2 });

    expect(policy.keepOriginals).toBe(true);
    expect(policy.maxAttachmentsPerMessage).toBe(2);
  });

  it('treats an empty column as the shipped default', () => {
    expect(readContentPolicy({})).toEqual(DEFAULT_CONTENT_POLICY);
    expect(readContentPolicy(null)).toEqual(DEFAULT_CONTENT_POLICY);
    expect(readContentPolicy(undefined)).toEqual(DEFAULT_CONTENT_POLICY);
  });

  it('falls back to the default rather than throwing on a column that holds nonsense', () => {
    // A brand whose row somehow holds rubbish must still be able to work
    // tickets — with the conservative policy, not with none.
    expect(readContentPolicy({ image: 'yes please' })).toEqual(DEFAULT_CONTENT_POLICY);
    expect(readContentPolicy('not an object')).toEqual(DEFAULT_CONTENT_POLICY);
  });
});

describe('checkUpload', () => {
  it('allows what the brand allows', () => {
    expect(
      checkUpload(DEFAULT_CONTENT_POLICY, { kind: 'image', mime: 'image/png', size: 1_024 }),
    ).toBe(DEFAULT_CONTENT_POLICY.image);
  });

  it('refuses a kind the brand has switched off, before it complains about anything else', () => {
    const policy = readContentPolicy({
      video: { enabled: false, maxBytes: 1, allowedMime: ['video/mp4'] },
    });

    // Both the size and the switch are wrong here; "video is off" is the answer
    // a person needs, and "too big" would send them to shrink a file for
    // nothing.
    expect(
      refusal(() => checkUpload(policy, { kind: 'video', mime: 'video/mp4', size: 50 * MIB }))
        .reason,
    ).toBe('kind_disabled');
  });

  it('refuses a type the brand does not allow', () => {
    expect(
      refusal(() =>
        checkUpload(DEFAULT_CONTENT_POLICY, {
          kind: 'image',
          mime: 'image/svg+xml',
          size: 1_024,
        }),
      ).reason,
    ).toBe('mime_not_allowed');
  });

  it('refuses a type the pipeline cannot verify, even when the brand allowed it', () => {
    // A policy that names something with no signature is a policy the worker
    // could never check. Refusing at presign beats storing bytes nothing can
    // vouch for.
    const policy = readContentPolicy({
      file: { enabled: true, maxBytes: 1_000_000, allowedMime: ['text/html'] },
    });

    expect(
      refusal(() => checkUpload(policy, { kind: 'file', mime: 'text/html', size: 10 })).reason,
    ).toBe('mime_not_allowed');
  });

  it('refuses one byte past the cap, per kind', () => {
    for (const [kind, mime, cap] of [
      ['image', 'image/png', 10 * MIB],
      ['video', 'video/mp4', 50 * MIB],
      ['audio', 'audio/ogg', 5 * MIB],
      ['file', 'application/pdf', 25 * MIB],
    ] as const) {
      expect(checkUpload(DEFAULT_CONTENT_POLICY, { kind, mime, size: cap })).toBeDefined();
      expect(
        refusal(() => checkUpload(DEFAULT_CONTENT_POLICY, { kind, mime, size: cap + 1 })).reason,
        kind,
      ).toBe('too_large');
    }
  });

  it('measures an audio upload against the voice switch', () => {
    const policy = readContentPolicy({
      voice: { enabled: false, maxBytes: 5 * MIB, allowedMime: ['audio/ogg'] },
    });

    expect(
      refusal(() => checkUpload(policy, { kind: 'audio', mime: 'audio/ogg', size: 10 })).reason,
    ).toBe('kind_disabled');
  });

  it('never quotes the upload in the message it throws', () => {
    const thrown = refusal(() =>
      checkUpload(DEFAULT_CONTENT_POLICY, {
        kind: 'image',
        mime: 'image/svg+xml',
        size: 1,
      }),
    );

    expect(thrown.message).not.toContain('svg');
  });
});
