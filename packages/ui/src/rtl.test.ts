import { compile, middleware, serialize, stringify } from 'stylis';
import { describe, expect, it } from 'vitest';
import { createLtrCache, createRtlCache, RTL_STYLIS_PLUGINS } from './rtl.js';

const render = (css: string, plugins: readonly unknown[]): string =>
  serialize(compile(css), middleware([...plugins, stringify] as Parameters<typeof middleware>[0]));

describe('RTL_STYLIS_PLUGINS', () => {
  it('mirrors a physical property', () => {
    expect(render('.a{margin-left:8px;}', RTL_STYLIS_PLUGINS)).toContain('margin-right:8px');
  });

  it('leaves a logical property alone, so Helpdock styles pass through', () => {
    expect(render('.a{margin-inline-start:8px;}', RTL_STYLIS_PLUGINS)).toContain(
      'margin-inline-start:8px',
    );
  });

  it('still prefixes, which replacing the plugin list would otherwise turn off', () => {
    expect(render('.a{user-select:none;}', RTL_STYLIS_PLUGINS)).toContain('-webkit-user-select');
  });
});

describe('createRtlCache', () => {
  it('uses a key of its own so the two caches never collide', () => {
    expect(createRtlCache().key).toBe('hdrtl');
    expect(createLtrCache().key).toBe('hd');
  });
});
