import { WIDGET_EVENTS } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../testing/silent-logger.js';
import { agentTypingRelay } from './agent-typing.js';
import { WidgetHub } from './widget-hub.js';
import {
  brandVisitorsRoom,
  conversationRoom,
  parseWidgetEmit,
  RedisWidgetBroadcast,
  WIDGET_EMIT_CHANNEL,
  widgetEnvelope,
} from './widget-relay.js';

const CONVERSATION = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

const typing = { conversationId: CONVERSATION, typing: true, agentName: null };

const publishing = () => {
  const published: { channel: string; message: string }[] = [];
  const redis = {
    publish: vi.fn(async (channel: string, message: string) => {
      published.push({ channel, message });
      return 1;
    }),
  } as unknown as Redis;
  return { redis, published };
};

describe('RedisWidgetBroadcast', () => {
  it('publishes a checked frame on the widget channel', async () => {
    const { redis, published } = publishing();

    await new RedisWidgetBroadcast(redis).emit({
      room: conversationRoom(CONVERSATION),
      event: WIDGET_EVENTS.typing,
      data: typing,
      seq: null,
    });

    expect(published[0]?.channel).toBe(WIDGET_EMIT_CHANNEL);
    expect(JSON.parse(published[0]?.message ?? '{}')).toEqual({
      room: `conversation:${CONVERSATION}`,
      event: 'typing',
      data: typing,
      seq: null,
    });
  });

  it('refuses a payload that does not match its event, and a room that is not a widget room', async () => {
    const { redis } = publishing();
    const broadcast = new RedisWidgetBroadcast(redis);

    await expect(
      broadcast.emit({
        room: conversationRoom(CONVERSATION),
        event: WIDGET_EVENTS.presence,
        data: {} as never,
        seq: null,
      }),
    ).rejects.toThrow();
    await expect(
      broadcast.emit({
        room: `ticket:${CONVERSATION}`,
        event: WIDGET_EVENTS.typing,
        data: typing,
        seq: null,
      }),
    ).rejects.toThrow();
  });
});

describe('parseWidgetEmit', () => {
  it('drops anything malformed, unknown or mismatched', () => {
    expect(parseWidgetEmit('not json')).toBeNull();
    expect(
      parseWidgetEmit(
        JSON.stringify({ room: brandVisitorsRoom(BRAND), event: 'nope', data: {}, seq: null }),
      ),
    ).toBeNull();
    expect(
      parseWidgetEmit(
        JSON.stringify({
          room: brandVisitorsRoom(BRAND),
          event: 'presence',
          data: { x: 1 },
          seq: null,
        }),
      ),
    ).toBeNull();
    expect(
      parseWidgetEmit(
        JSON.stringify({
          room: brandVisitorsRoom(BRAND),
          event: 'presence',
          data: { agentsOnline: true, agents: [{ name: 'Lina', avatarUrl: null }] },
          seq: null,
        }),
      ),
    ).toMatchObject({
      room: `visitors:${BRAND}`,
      event: 'presence',
      envelope: {
        seq: null,
        data: { agentsOnline: true, agents: [{ name: 'Lina', avatarUrl: null }] },
      },
    });
  });
});

describe('WidgetHub', () => {
  const frame = JSON.stringify({
    room: conversationRoom(CONVERSATION),
    event: 'typing',
    data: typing,
    seq: null,
  });

  it("hands a frame to this replica's sockets in the room and to its streams", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const hub = new WidgetHub({} as Redis, silentLogger());
    hub.bind({ local: { to } } as never);
    const listener = vi.fn();
    const stop = hub.listen(conversationRoom(CONVERSATION), listener);

    hub.deliver(frame);
    stop();
    hub.deliver(frame);

    expect(to).toHaveBeenCalledWith(`conversation:${CONVERSATION}`);
    expect(emit).toHaveBeenCalledWith(
      'typing',
      expect.objectContaining({ data: typing, seq: null }),
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(hub.streamCount()).toBe(0);
  });

  it('logs and drops a frame it cannot read', () => {
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');
    new WidgetHub({} as Redis, logger).deliver('{');

    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('agentTypingRelay', () => {
  it("turns an agent's open composer into the visitor's typing dot, and viewing into its end", async () => {
    const { redis, published } = publishing();
    const relay = agentTypingRelay(new RedisWidgetBroadcast(redis));
    const base = { brandId: BRAND, ticketId: CONVERSATION, userId: BRAND };

    relay({ ...base, activity: 'replying' });
    relay({ ...base, activity: 'viewing' });
    await vi.waitFor(() => expect(published).toHaveLength(2));

    expect(published.map((entry) => JSON.parse(entry.message).data.typing)).toEqual([true, false]);
  });
});

describe('widgetEnvelope', () => {
  it('is the staff shape: seq, when and the checked payload', () => {
    const at = new Date('2026-09-27T10:00:00.000Z');
    expect(widgetEnvelope(WIDGET_EVENTS.typing, typing, null, at)).toEqual({
      seq: null,
      at: '2026-09-27T10:00:00.000Z',
      data: typing,
    });
  });
});
