import { PRESENCE_AWAY_AFTER_MS } from '@helpdock/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_EVENTS, watchActivity } from './activity.js';

/** Enough of an `EventTarget` to fire one event, and to count what was unbound. */
class FakeTarget {
  readonly handlers = new Map<string, Set<EventListener>>();

  addEventListener(event: string, handler: EventListener): void {
    const handlers = this.handlers.get(event) ?? new Set<EventListener>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  removeEventListener(event: string, handler: EventListener): void {
    this.handlers.get(event)?.delete(handler);
  }

  fire(event: string): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(new Event(event));
    }
  }

  bound(): number {
    return [...this.handlers.values()].reduce((total, set) => total + set.size, 0);
  }
}

describe('watchActivity', () => {
  let target: FakeTarget;
  let idle: number;
  let active: number;

  const watch = (idleMs = PRESENCE_AWAY_AFTER_MS) =>
    watchActivity({
      target,
      idleMs,
      onIdle: () => {
        idle += 1;
      },
      onActive: () => {
        active += 1;
      },
    });

  beforeEach(() => {
    vi.useFakeTimers();
    target = new FakeTarget();
    idle = 0;
    active = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls idle after five minutes of nothing (DOMAIN-RULES §12)', () => {
    watch();

    vi.advanceTimersByTime(PRESENCE_AWAY_AFTER_MS - 1);
    expect(idle).toBe(0);

    vi.advanceTimersByTime(1);
    expect(idle).toBe(1);
  });

  it.each([...ACTIVITY_EVENTS, 'visibilitychange'])('treats %s as a sign of life', (event) => {
    watch();

    vi.advanceTimersByTime(PRESENCE_AWAY_AFTER_MS - 10);
    target.fire(event);
    vi.advanceTimersByTime(20);

    expect(idle).toBe(0);
  });

  it('calls active once when somebody comes back, and not on every keystroke', () => {
    watch();
    vi.advanceTimersByTime(PRESENCE_AWAY_AFTER_MS);

    target.fire('keydown');
    target.fire('keydown');

    expect([idle, active]).toEqual([1, 1]);
  });

  it('goes idle again after another quiet five minutes', () => {
    watch();
    vi.advanceTimersByTime(PRESENCE_AWAY_AFTER_MS);
    target.fire('keydown');

    vi.advanceTimersByTime(PRESENCE_AWAY_AFTER_MS);

    expect(idle).toBe(2);
  });

  it('unbinds everything and cancels the timer when it is stopped', () => {
    const watcher = watch();
    expect(target.bound()).toBe(ACTIVITY_EVENTS.length + 1);

    watcher.stop();
    vi.advanceTimersByTime(PRESENCE_AWAY_AFTER_MS * 2);

    expect(target.bound()).toBe(0);
    expect(idle).toBe(0);
  });
});
