import { brandRoom, REALTIME_EVENTS } from '@helpdock/schemas';
import type { Namespace } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { RealtimePublisher } from './publisher.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const LINA = '01937f5e-7e53-7000-8000-000000000001';

interface Emitted {
  readonly room: string;
  readonly event: string;
  readonly envelope: { seq: number | null; at: string; data: unknown };
}

const namespaceRecording = (into: Emitted[]): Namespace =>
  ({
    to: (room: string) => ({
      emit: (event: string, envelope: Emitted['envelope']) => {
        into.push({ room, event, envelope });
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: the double implements the one method the publisher calls.
  }) as any;

describe('RealtimePublisher', () => {
  const payload = { userId: LINA, brandId: BRAND, status: 'online' } as const;

  it('wraps the payload in the envelope of DOMAIN-RULES §7', () => {
    const emitted: Emitted[] = [];
    const publisher = new RealtimePublisher();
    publisher.bind(namespaceRecording(emitted));

    publisher.emitToRoom(brandRoom(BRAND), REALTIME_EVENTS.presenceChanged, payload);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.room).toBe(brandRoom(BRAND));
    expect(emitted[0]?.event).toBe(REALTIME_EVENTS.presenceChanged);
    expect(emitted[0]?.envelope.data).toEqual(payload);
    expect(emitted[0]?.envelope.seq).toBeNull();
    expect(Date.parse(emitted[0]?.envelope.at ?? '')).not.toBeNaN();
  });

  it('carries the cursor M1 will need when one is given', () => {
    const publisher = new RealtimePublisher();

    expect(publisher.envelope(REALTIME_EVENTS.presenceChanged, payload, { seq: 12 }).seq).toBe(12);
  });

  it('refuses to emit a payload that does not match its schema', () => {
    const emitted: Emitted[] = [];
    const publisher = new RealtimePublisher();
    publisher.bind(namespaceRecording(emitted));

    expect(() =>
      publisher.emitToRoom(brandRoom(BRAND), REALTIME_EVENTS.presenceChanged, {
        ...payload,
        // biome-ignore lint/suspicious/noExplicitAny: proving the boundary rejects it is the point.
        status: 'busy' as any,
      }),
    ).toThrow();
    expect(emitted).toEqual([]);
  });

  it('refuses a room name that is not one', () => {
    const publisher = new RealtimePublisher();
    publisher.bind(namespaceRecording([]));

    expect(() =>
      publisher.emitToRoom('everyone', REALTIME_EVENTS.presenceChanged, payload),
    ).toThrow();
  });

  it('drops an emit made before the namespace exists rather than throwing at a caller', () => {
    // Sockets are notifications; nothing may fail because one could not be sent.
    expect(() =>
      new RealtimePublisher().emitToRoom(
        brandRoom(BRAND),
        REALTIME_EVENTS.presenceChanged,
        payload,
      ),
    ).not.toThrow();
  });
});
