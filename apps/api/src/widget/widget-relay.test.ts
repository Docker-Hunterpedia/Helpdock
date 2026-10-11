import { WIDGET_EVENTS } from '@helpdock/schemas';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../testing/silent-logger.js';
import { agentTypingRelay } from './agent-typing.js';
import { WidgetHub } from './widget-hub.js';
import {
  brandVisitorsRoom,
  conversationRoom,
  disconnectVisitorMessage,
  parseWidgetMessage,
  RedisWidgetBroadcast,
  WIDGET_EMIT_CHANNEL,
  widgetEnvelope,
} from './widget-relay.js';

const CONVERSATION = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const VISITOR = '0192c3f0-1a2b-7c3d-8e4f-0000000000c1';
const OTHER_VISITOR = '0192c3f0-1a2b-7c3d-8e4f-0000000000c2';

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

describe('parseWidgetMessage', () => {
  it('drops anything malformed, unknown or mismatched', () => {
    expect(parseWidgetMessage('not json')).toBeNull();
    expect(
      parseWidgetMessage(
        JSON.stringify({ room: brandVisitorsRoom(BRAND), event: 'nope', data: {}, seq: null }),
      ),
    ).toBeNull();
    expect(
      parseWidgetMessage(
        JSON.stringify({
          room: brandVisitorsRoom(BRAND),
          event: 'presence',
          data: { x: 1 },
          seq: null,
        }),
      ),
    ).toBeNull();
    expect(
      parseWidgetMessage(
        JSON.stringify({
          room: brandVisitorsRoom(BRAND),
          event: 'presence',
          data: { agentsOnline: true, agents: [{ name: 'Lina', avatarUrl: null }] },
          seq: null,
        }),
      ),
    ).toMatchObject({
      kind: 'emit',
      room: `visitors:${BRAND}`,
      event: 'presence',
      envelope: {
        seq: null,
        data: { agentsOnline: true, agents: [{ name: 'Lina', avatarUrl: null }] },
      },
    });
  });

  it('reads the instruction to end a visitor’s streams, for a visitor id and nothing else', () => {
    expect(parseWidgetMessage(disconnectVisitorMessage(VISITOR))).toEqual({
      kind: 'disconnect-visitor',
      visitorId: VISITOR,
    });
    expect(parseWidgetMessage(JSON.stringify({ disconnectVisitor: 'everyone' }))).toBeNull();
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

  it('ends the streams of the visitor an instruction names, and no one else’s', () => {
    const hub = new WidgetHub({} as Redis, silentLogger());
    const theirs = vi.fn();
    const others = vi.fn();
    hub.watchVisitor(VISITOR, theirs);
    hub.watchVisitor(OTHER_VISITOR, others);

    hub.deliver(disconnectVisitorMessage(VISITOR));

    expect(theirs).toHaveBeenCalledOnce();
    expect(others).not.toHaveBeenCalled();
  });

  it('stops watching a visitor whose stream has ended', () => {
    const hub = new WidgetHub({} as Redis, silentLogger());
    const close = vi.fn();
    hub.watchVisitor(VISITOR, close)();

    hub.deliver(disconnectVisitorMessage(VISITOR));

    expect(close).not.toHaveBeenCalled();
  });

  it('cuts the visitor’s sockets and tells every replica to end their streams', async () => {
    const { redis, published } = publishing();
    const disconnectSockets = vi.fn();
    const inRoom = vi.fn(() => ({ disconnectSockets }));
    const hub = new WidgetHub(redis, silentLogger());
    hub.bind({ in: inRoom } as never);

    await hub.disconnectVisitor(VISITOR);

    expect(inRoom).toHaveBeenCalledWith(`visitor:${VISITOR}`);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    expect(published).toEqual([
      { channel: WIDGET_EMIT_CHANNEL, message: disconnectVisitorMessage(VISITOR) },
    ]);
  });

  it('logs, and does not throw, when the instruction cannot be published', async () => {
    const logger = silentLogger();
    const error = vi.spyOn(logger, 'error');
    const redis = { publish: vi.fn().mockRejectedValue(new Error('redis is down')) } as never;

    await expect(new WidgetHub(redis, logger).disconnectVisitor(VISITOR)).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledOnce();
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
