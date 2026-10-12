import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as root from './index.js';
import * as testing from './testing.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  exports: Record<string, { types: string; default: string }>;
};

describe('@helpdock/channels', () => {
  it('exports the name declared in package.json', () => {
    expect(root.PACKAGE_NAME).toBe(manifest.name);
  });

  it('keeps the test doubles out of the entry point the api and the worker load', () => {
    for (const name of ['FakeGraph', 'MetaWebhookDriver', 'META_FIXTURE', 'whatsappText']) {
      expect(root).not.toHaveProperty(name);
      expect(testing).toHaveProperty(name);
    }
  });

  it('publishes the doubles as the ./testing subpath, built next to the entry point', () => {
    expect(manifest.exports['./testing']).toEqual({
      types: './dist/testing.d.ts',
      default: './dist/testing.js',
    });
  });
});
