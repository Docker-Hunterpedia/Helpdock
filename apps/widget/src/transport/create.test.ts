import { describe, expect, it, vi } from 'vitest';
import { createTransport } from './create.js';
import { sampleMockOptions } from './fixtures.js';
import { MockTransport } from './mock.js';

const OPTIONS = { apiOrigin: 'https://support.example.com', brand: 'brand-1' };

describe('createTransport', () => {
  it('fetches the real transport once, on the first call, and hands every call to it', async () => {
    const remote = new MockTransport(sampleMockOptions('en'));
    const load = vi.fn(async () => remote);
    const transport = createTransport(OPTIONS, load);

    expect(load).not.toHaveBeenCalled();
    const [config, session] = await Promise.all([
      transport.getConfig('en'),
      transport.startSession(null),
    ]);

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(OPTIONS);
    expect(config.brand.name).toBe('Helpdock');
    expect(session.visitor_id).toBe('visitor-1');
  });

  it('reports a chunk that will not load as the network, and tries again on the next call', async () => {
    const remote = new MockTransport(sampleMockOptions('en'));
    const load = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValue(remote);
    const transport = createTransport(OPTIONS, load);

    await expect(transport.getConfig('en')).rejects.toMatchObject({ code: 'network' });
    await expect(transport.getConfig('en')).resolves.toMatchObject({ mode: 'chat' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('subscribes once the chunk is there, and not at all when unsubscribed first', async () => {
    const remote = new MockTransport(sampleMockOptions('en'));
    const subscribe = vi.spyOn(remote, 'subscribe');
    const transport = createTransport(OPTIONS, async () => remote);
    const subscription = { onEvent: vi.fn(), onConnection: vi.fn() };

    transport.subscribe(null, subscription)();
    const unsubscribe = transport.subscribe('conversation-1', subscription);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    unsubscribe();

    expect(subscribe).toHaveBeenCalledWith('conversation-1', subscription);
  });

  it('tells a subscriber it is reconnecting when the chunk cannot be fetched', async () => {
    const transport = createTransport(OPTIONS, () => Promise.reject(new Error('offline')));
    const onConnection = vi.fn();

    transport.subscribe(null, { onEvent: vi.fn(), onConnection });
    transport.sendTyping('conversation-1', true);

    await vi.waitFor(() => expect(onConnection).toHaveBeenCalledWith('reconnecting'));
  });
});
