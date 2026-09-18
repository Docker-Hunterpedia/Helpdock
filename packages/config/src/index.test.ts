import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as crypto from './crypto.js';
import * as env from './env.js';
import * as index from './index.js';
import * as invalidation from './invalidation.js';
import * as registry from './registry.js';
import * as settings from './settings.js';

const modules: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'crypto.ts': crypto,
  'env.ts': env,
  'invalidation.ts': invalidation,
  'registry.ts': registry,
  'settings.ts': settings,
};

describe('@helpdock/config', () => {
  it('has an entry point that knows about every module in the package', () => {
    const files = readdirSync(new URL('.', import.meta.url))
      .filter((file) => file.endsWith('.ts') && !file.includes('.test.') && file !== 'index.ts')
      .sort();

    expect(files).toEqual(Object.keys(modules).sort());
  });

  it('re-exports every public name, so consumers import from @helpdock/config alone', () => {
    for (const [file, module] of Object.entries(modules)) {
      for (const name of Object.keys(module)) {
        expect(index, `${file} exports ${name}`).toHaveProperty(name);
      }
    }
  });
});
