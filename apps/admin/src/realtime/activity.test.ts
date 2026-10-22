import { PRESENCE_ACTIVITY_REPORT_INTERVAL_MS } from '@helpdock/schemas';
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

const INTERVAL = PRESENCE_ACTIVITY_REPORT_INTERVAL_MS;

describe('watchActivity (M14-18)', () => {
  let target: FakeTarget;
  let reports: number;
  let visible: boolean;

  const watch = (intervalMs = INTERVAL) =>
    watchActivity({
      target,
      intervalMs,
      isVisible: () => visible,
      report: () => {
        reports += 1;
      },
    });

  beforeEach(() => {
    vi.useFakeTimers();
    target = new FakeTarget();
    reports = 0;
    visible = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports once on start: opening the app is activity', () => {
    watch();

    expect(reports).toBe(1);
  });

  it.each(ACTIVITY_EVENTS)('reports %s once the interval has passed', (event) => {
    watch();
    vi.advanceTimersByTime(INTERVAL);

    target.fire(event);

    expect(reports).toBe(2);
  });

  it('reports a tab becoming visible again, and ignores one becoming hidden', () => {
    watch();
    vi.advanceTimersByTime(INTERVAL);

    visible = false;
    target.fire('visibilitychange');
    expect(reports).toBe(1);

    visible = true;
    target.fire('visibilitychange');
    expect(reports).toBe(2);
  });

  it('sends at most one report per interval, however busy the person is', () => {
    watch();

    for (let keystroke = 0; keystroke < 200; keystroke += 1) {
      vi.advanceTimersByTime(100);
      target.fire('keydown');
    }
    // 20 s of typing: still the one report from the start, and one waiting.
    expect(reports).toBe(1);

    vi.advanceTimersByTime(INTERVAL);
    expect(reports).toBe(2);
  });

  it('does not lose activity inside the interval: one report goes out when it ends', () => {
    watch();
    vi.advanceTimersByTime(20_000);
    target.fire('pointerdown');
    expect(reports).toBe(1);

    vi.advanceTimersByTime(INTERVAL - 20_000 - 1);
    expect(reports).toBe(1);

    vi.advanceTimersByTime(1);
    expect(reports).toBe(2);
  });

  it('sends nothing for a quiet interval, so silence is what the server sees', () => {
    watch();

    vi.advanceTimersByTime(INTERVAL * 10);

    expect(reports).toBe(1);
  });

  it('unbinds everything and cancels a waiting report when it is stopped', () => {
    const watcher = watch();
    target.fire('keydown');
    expect(target.bound()).toBe(ACTIVITY_EVENTS.length + 1);

    watcher.stop();
    vi.advanceTimersByTime(INTERVAL * 2);

    expect(target.bound()).toBe(0);
    expect(reports).toBe(1);
  });

  it('carries nothing about the event: the report takes no arguments', () => {
    const report = vi.fn();
    watchActivity({ target, report, isVisible: () => true });
    vi.advanceTimersByTime(INTERVAL);

    target.fire('keydown');

    expect(report).toHaveBeenLastCalledWith();
  });
});
