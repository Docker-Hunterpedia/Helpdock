import { expect, it } from 'vitest';
import { importAttachmentAvailabilitySchema } from './import-media.js';

it.each(['downloadUrl', 'storageKey', 'policyHash', 'credentials'])(
  'refuses private %s inside the public file-inspection result',
  (key) => {
    expect(
      importAttachmentAvailabilitySchema.safeParse({
        state: 'available',
        size: 42,
        mime: 'application/pdf',
        [key]: 'private-source-value',
      }).success,
    ).toBe(false);
  },
);
