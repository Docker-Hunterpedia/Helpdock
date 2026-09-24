import { describe, expect, it, vi } from 'vitest';
import { RealtimeListeners, RoomMemberships } from './client.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const TICKET = '0192c3f0-1a2b-7c3d-8e4f-000000001042';
const ROOM = `ticket:${TICKET}`;

describe('RoomMemberships', () => {
  it('asks for a join only on the first holder', () => {
    const rooms = new RoomMemberships();

    expect(rooms.acquire(ROOM)).toBe(true);
    expect(rooms.acquire(ROOM)).toBe(false);
  });

  it('leaves only when the last holder lets go', () => {
    const rooms = new RoomMemberships();
    rooms.acquire(ROOM);
    rooms.acquire(ROOM);

    expect(rooms.release(ROOM)).toBe(false);
    expect(rooms.release(ROOM)).toBe(true);
  });

  it('does not leave a room nobody held', () => {
    expect(new RoomMemberships().release(ROOM)).toBe(false);
  });

  it('lists what a reconnect has to join again', () => {
    const rooms = new RoomMemberships();
    rooms.acquire(ROOM);
    rooms.acquire(`brand:${BRAND}`);

    expect([...rooms.rooms()].sort()).toEqual([`brand:${BRAND}`, ROOM]);

    rooms.release(ROOM);
    expect(rooms.rooms()).toEqual([`brand:${BRAND}`]);
  });

  it('forgets everything when the connection is given up', () => {
    const rooms = new RoomMemberships();
    rooms.acquire(ROOM);
    rooms.clear();

    expect(rooms.rooms()).toEqual([]);
  });
});

describe('RealtimeListeners', () => {
  it('delivers each kind of event to whoever asked for it', () => {
    const listeners = new RealtimeListeners();
    const ticketChanged = vi.fn();
    const ticketMessage = vi.fn();
    const ticketViewing = vi.fn();
    listeners.add({ ticketChanged, ticketMessage, ticketViewing });

    listeners.ticketChanged({
      brandId: BRAND,
      ticketId: TICKET,
      departmentId: BRAND,
      event: 'ticket.updated',
    });
    listeners.ticketMessage({
      brandId: BRAND,
      ticketId: TICKET,
      departmentId: BRAND,
      messageId: TICKET,
      seq: 4,
      kind: 'public',
      event: 'ticket.replied',
    });
    listeners.ticketViewing({ brandId: BRAND, ticketId: TICKET, userId: BRAND });

    expect(ticketChanged).toHaveBeenCalledOnce();
    expect(ticketMessage).toHaveBeenCalledOnce();
    expect(ticketViewing).toHaveBeenCalledOnce();
  });

  it('stops delivering once a listener has unsubscribed', () => {
    const listeners = new RealtimeListeners();
    const ticketViewing = vi.fn();
    const stop = listeners.add({ ticketViewing });
    stop();

    listeners.ticketViewing({ brandId: BRAND, ticketId: TICKET, userId: BRAND });

    expect(ticketViewing).not.toHaveBeenCalled();
  });

  it('delivers to a listener that unsubscribes another mid-flight', () => {
    const listeners = new RealtimeListeners();
    const second = vi.fn();
    const stopSecond = listeners.add({ ticketViewing: second });
    listeners.add({ ticketViewing: () => stopSecond() });

    listeners.ticketViewing({ brandId: BRAND, ticketId: TICKET, userId: BRAND });

    expect(second).toHaveBeenCalledOnce();
  });
});
