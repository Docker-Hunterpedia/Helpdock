import { GraphClient } from '@helpdock/channels';
import { describe, expect, it } from 'vitest';
import { graphClientFactory } from './graph-client-factory.js';

describe('graphClientFactory', () => {
  it('builds one client for the process, from the defaults when no key is set', () => {
    const factory = graphClientFactory({ OUTBOUND_ALLOW_CIDRS: [] });

    expect(factory()).toBeInstanceOf(GraphClient);
    expect(factory()).toBe(factory());
  });

  it('accepts the three META_* keys that point a suite at a stand-in', () => {
    const factory = graphClientFactory({
      META_GRAPH_VERSION: 'v25.0',
      META_GRAPH_API_ROOT: 'http://127.0.0.1:4010',
      META_INSTAGRAM_API_ROOT: 'http://127.0.0.1:4011',
      OUTBOUND_ALLOW_CIDRS: ['127.0.0.0/8'],
    });

    expect(factory()).toBeInstanceOf(GraphClient);
  });

  it('refuses a version Graph does not spell, at boot rather than at the first call', () => {
    expect(() =>
      graphClientFactory({ META_GRAPH_VERSION: '25', OUTBOUND_ALLOW_CIDRS: [] }),
    ).toThrow(TypeError);
  });
});
