import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollToHash } from './route-scroll.js';

describe('scrollToHash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const addTarget = (id: string): HTMLElement => {
    const el = document.createElement('section');
    el.id = id;
    el.scrollIntoView = vi.fn();
    document.body.append(el);
    return el;
  };

  it('scrolls to an element that is already there, with a 16 px margin', () => {
    const el = addTarget('outgoing-email');
    scrollToHash('#outgoing-email');
    expect(el.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(el.style.scrollMarginBlockStart).toBe('16px');
  });

  it('waits for an element that data adds later', () => {
    scrollToHash('#late');
    vi.advanceTimersByTime(500);
    const el = addTarget('late');
    vi.advanceTimersByTime(200);
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('gives up after the wait and when cancelled', () => {
    const cancel = scrollToHash('#never', 300);
    vi.advanceTimersByTime(1000);
    const el = addTarget('never');
    vi.advanceTimersByTime(1000);
    expect(el.scrollIntoView).not.toHaveBeenCalled();

    const stop = scrollToHash('#stopped');
    stop();
    const stopped = addTarget('stopped');
    vi.advanceTimersByTime(500);
    expect(stopped.scrollIntoView).not.toHaveBeenCalled();
    cancel();
  });

  it('does nothing for an empty fragment', () => {
    expect(() => scrollToHash('#')()).not.toThrow();
  });
});
