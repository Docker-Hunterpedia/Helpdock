import { DEFAULT_CONTENT_POLICY } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  checkAccent,
  checkOrigin,
  MIB,
  moveField,
  policyDraftOf,
  policyRequestOf,
  UPLOAD_LIMIT_MB,
} from './widget-draft.js';

describe('checkAccent', () => {
  it('passes the brand teal and fails a pale yellow, with the ratio of white text on each', () => {
    expect(checkAccent('#0F766E')).toEqual({ kind: 'pass', ratio: 5.5 });
    expect(checkAccent('#FDE68A')).toMatchObject({ kind: 'fail' });
    expect(checkAccent('teal')).toEqual({ kind: 'invalid' });
  });
});

describe('checkOrigin', () => {
  it('normalises an origin and refuses a path or a repeat', () => {
    expect(checkOrigin('https://Shop.Example.com/', [])).toEqual({
      ok: true,
      origin: 'https://shop.example.com',
    });
    expect(checkOrigin('shop.example.com/checkout', [])).toEqual({ ok: false, reason: 'invalid' });
    expect(checkOrigin('https://shop.example.com', ['https://shop.example.com'])).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });
});

describe('moveField', () => {
  const fields = [
    { kind: 'name', required: true },
    { kind: 'email', required: true },
    { kind: 'custom', key: 'plan', required: false },
  ] as const;

  it('moves a field one place, and stops at either end', () => {
    expect(moveField(fields, 'plan', -1).map((f) => f.kind)).toEqual(['name', 'custom', 'email']);
    expect(moveField(fields, 'name', -1)).toEqual(fields);
    expect(moveField(fields, 'missing', 1)).toEqual(fields);
  });
});

describe('policyRequestOf', () => {
  it('turns MB and the typed MIME list back into the policy', () => {
    const draft = policyDraftOf(DEFAULT_CONTENT_POLICY);
    draft.kinds.image = { enabled: false, maxMb: '4', types: 'image/png, image/webp' };
    draft.emoji = false;

    const outcome = policyRequestOf(draft, DEFAULT_CONTENT_POLICY);

    expect(outcome.ok && outcome.request).toMatchObject({
      emoji: false,
      image: { enabled: false, maxBytes: 4 * MIB, allowedMime: ['image/png', 'image/webp'] },
    });
  });

  it('names every field that stops the save', () => {
    const draft = policyDraftOf(DEFAULT_CONTENT_POLICY);
    draft.kinds.video.maxMb = String(UPLOAD_LIMIT_MB + 1);
    draft.kinds.voice.maxMb = 'ten';
    draft.kinds.file.types = 'pdf';
    draft.perMessage = '99';

    const outcome = policyRequestOf(draft, DEFAULT_CONTENT_POLICY);

    expect(outcome.ok ? [] : [...outcome.problems].sort()).toEqual([
      'perMessage',
      'size:voice',
      'tooLarge:video',
      'types:file',
    ]);
  });
});
