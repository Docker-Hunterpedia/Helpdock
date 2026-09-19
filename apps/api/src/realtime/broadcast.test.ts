import { REALTIME_EVENTS, ticketRoom } from '@helpdock/schemas';
import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../testing/silent-logger.js';
import {
  REALTIME_EMIT_CHANNEL,
  RealtimeEmitSubscriber,
  RedisRealtimeBroadcast,
} from './broadcast.js';
import { RealtimePublisher } from './publisher.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const DEPARTMENT = '01937f5e-7e53-7000-8000-000000000011';
const TICKET = '01937f5e-7e53-7000-8000-0000000000a1';

const frame = {
  brandId: BRAND,
  ticketId: TICKET,
  departmentId: DEPARTMENT,
  event: 'ticket.created',
} as const;

describe('RedisRealtimeBroadcast', () => {
  it('publishes the rooms, the event and the seq on one channel', async () => {
    const publish = vi.fn().mockResolvedValue(1);

    await new RedisRealtimeBroadcast({ publish } as never).emit({
      rooms: [ticketRoom(TICKET)],
      event: REALTIME_EVENTS.ticketChanged,
      data: frame,
      seq: null,
    });

    expect(publish).toHaveBeenCalledWith(
      REALTIME_EMIT_CHANNEL,
      JSON.stringify({
        rooms: [ticketRoom(TICKET)],
        event: REALTIME_EVENTS.ticketChanged,
        data: frame,
        seq: null,
        evict: [],
      }),
    );
  });
});

describe('RealtimeEmitSubscriber', () => {
  const subscriberWith = (publisher: RealtimePublisher) =>
    new RealtimeEmitSubscriber({} as never, publisher, silentLogger());

  const message = (body: unknown) => JSON.stringify(body);

  it('emits to this replica only, because Redis has already fanned the message out', () => {
    // Every replica receives the message. Without `local` the Socket.IO adapter
    // would fan it out again and a room would hear the frame once per replica.
    const publisher = new RealtimePublisher();
    const emit = vi.spyOn(publisher, 'emitToRoom').mockImplementation(() => {});

    subscriberWith(publisher).deliver(
      message({
        rooms: [ticketRoom(TICKET)],
        event: REALTIME_EVENTS.ticketChanged,
        data: frame,
        seq: null,
      }),
    );

    expect(emit).toHaveBeenCalledWith(ticketRoom(TICKET), REALTIME_EVENTS.ticketChanged, frame, {
      local: true,
    });
  });

  it('passes a seq through when the event carries one', () => {
    const publisher = new RealtimePublisher();
    const emit = vi.spyOn(publisher, 'emitToRoom').mockImplementation(() => {});

    subscriberWith(publisher).deliver(
      message({
        rooms: [ticketRoom(TICKET)],
        event: REALTIME_EVENTS.ticketMessage,
        data: {
          ...frame,
          messageId: '01937f5e-7e53-7000-8000-0000000000b1',
          seq: 3,
          kind: 'public',
          event: 'ticket.replied',
        },
        seq: 3,
      }),
    );

    expect(emit).toHaveBeenCalledWith(
      ticketRoom(TICKET),
      REALTIME_EVENTS.ticketMessage,
      expect.anything(),
      { seq: 3, local: true },
    );
  });

  it('emits once per room named', () => {
    const publisher = new RealtimePublisher();
    const emit = vi.spyOn(publisher, 'emitToRoom').mockImplementation(() => {});

    subscriberWith(publisher).deliver(
      message({
        rooms: [ticketRoom(TICKET), `department:${DEPARTMENT}`],
        event: REALTIME_EVENTS.ticketChanged,
        data: frame,
        seq: null,
      }),
    );

    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('turns the named rooms out after delivering the frame', () => {
    // Order matters: the clients being turned out are told what happened first,
    // and re-join through the same check they passed once.
    const order: string[] = [];
    const publisher = new RealtimePublisher();
    vi.spyOn(publisher, 'emitToRoom').mockImplementation(() => void order.push('emit'));
    vi.spyOn(publisher, 'evictRoom').mockImplementation(() => void order.push('evict'));

    subscriberWith(publisher).deliver(
      message({
        rooms: [ticketRoom(TICKET)],
        event: REALTIME_EVENTS.ticketChanged,
        data: frame,
        seq: null,
        evict: [ticketRoom(TICKET)],
      }),
    );

    expect(order).toEqual(['emit', 'evict']);
  });

  it('turns nobody out when the message names no room to evict', () => {
    const publisher = new RealtimePublisher();
    vi.spyOn(publisher, 'emitToRoom').mockImplementation(() => {});
    const evict = vi.spyOn(publisher, 'evictRoom').mockImplementation(() => {});

    subscriberWith(publisher).deliver(
      message({
        rooms: [ticketRoom(TICKET)],
        event: REALTIME_EVENTS.ticketChanged,
        data: frame,
        seq: null,
      }),
    );

    expect(evict).not.toHaveBeenCalled();
  });

  it('ignores a message that is not JSON', () => {
    const publisher = new RealtimePublisher();
    const emit = vi.spyOn(publisher, 'emitToRoom').mockImplementation(() => {});

    subscriberWith(publisher).deliver('not json');

    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores a message whose rooms are not room names', () => {
    // Anything with PUBLISH on this Redis can write to the channel, so the
    // payload is parsed rather than trusted.
    const publisher = new RealtimePublisher();
    const emit = vi.spyOn(publisher, 'emitToRoom').mockImplementation(() => {});

    subscriberWith(publisher).deliver(
      message({ rooms: ['*'], event: REALTIME_EVENTS.ticketChanged, data: frame, seq: null }),
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores a payload that does not match the event it named', () => {
    // Only the envelope was parsed before; the payload crosses the same process
    // boundary and anything with PUBLISH on this Redis can write it. A throw
    // here would be an unhandled rejection inside a Redis message handler, so
    // the frame is dropped instead.
    const publisher = new RealtimePublisher();
    const emit = vi.spyOn(publisher, 'emitToRoom').mockImplementation(() => {});

    subscriberWith(publisher).deliver(
      message({
        rooms: [ticketRoom(TICKET)],
        event: REALTIME_EVENTS.ticketChanged,
        data: { brandId: BRAND, ticketId: 'not-a-uuid' },
        seq: null,
      }),
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores an event this replica does not know, which is what a rolling deploy looks like', () => {
    const publisher = new RealtimePublisher();
    const emit = vi.spyOn(publisher, 'emitToRoom').mockImplementation(() => {});

    subscriberWith(publisher).deliver(
      message({ rooms: [ticketRoom(TICKET)], event: 'ticket:invented', data: {}, seq: null }),
    );

    expect(emit).not.toHaveBeenCalled();
  });
});
