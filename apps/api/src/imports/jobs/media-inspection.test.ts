import { expect, it } from 'vitest';
import { inspectedAttachmentAvailability } from './media-inspection.js';

const binding = {
  fingerprint: 'a'.repeat(64),
  payloadHash: 'b'.repeat(64),
  policyHash: 'c'.repeat(64),
};
const receipt = {
  version: 1,
  ...binding,
  outcome: { state: 'available', size: 42, mime: 'application/pdf' },
};

it.each(['fingerprint', 'payloadHash', 'policyHash'] as const)(
  'does not advertise an inspection after its %s changes',
  (key) => {
    expect(inspectedAttachmentAvailability(receipt, { ...binding, [key]: 'd'.repeat(64) })).toEqual(
      { state: 'not_checked' },
    );
  },
);

it.each([
  [
    { state: 'available', size: 42, mime: 'application/pdf' },
    { state: 'available', size: 42, mime: 'application/pdf' },
  ],
  [
    { state: 'warning', code: 'media-unavailable' },
    { state: 'unavailable', code: 'media-unavailable' },
  ],
  [
    { state: 'error', code: 'media-mime_mismatch' },
    { state: 'rejected', code: 'media-mime_mismatch' },
  ],
])('exposes the sealed file outcome without its private receipt: %j', (outcome, expected) => {
  expect(inspectedAttachmentAvailability({ ...receipt, outcome }, binding)).toEqual(expected);
});

it('does not treat missing, malformed or URL-bearing legacy receipts as available', () => {
  for (const raw of [
    null,
    {},
    { ...receipt, downloadUrl: 'https://source.test/file?token=secret' },
  ])
    expect(inspectedAttachmentAvailability(raw, binding)).toEqual({ state: 'not_checked' });
});
