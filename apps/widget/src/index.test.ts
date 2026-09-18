import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@helpdock/widget', () => {
  it('exports the name declared in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: string };

    expect(PACKAGE_NAME).toBe(manifest.name);
  });
});
