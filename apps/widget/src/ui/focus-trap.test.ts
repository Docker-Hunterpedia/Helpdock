import { afterEach, describe, expect, it } from 'vitest';
import { wrapFocus } from './focus-trap.js';

afterEach(() => {
  document.body.replaceChildren();
});

const panel = () => {
  const container = document.createElement('section');
  container.innerHTML =
    '<button id="first">Minimise</button><button disabled>Off</button><input id="middle"><button id="last">Send</button>';
  document.body.append(container);
  const byId = (id: string) => container.querySelector<HTMLElement>(`#${id}`) as HTMLElement;
  return { container, first: byId('first'), middle: byId('middle'), last: byId('last') };
};

const tab = (container: HTMLElement, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
  wrapFocus(container, event);
  return event;
};

describe('wrapFocus', () => {
  it('sends Tab from the last stop back to the first', () => {
    const { container, first, last } = panel();
    last.focus();

    const event = tab(container);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('sends Shift+Tab from the first stop to the last, skipping disabled controls', () => {
    const { container, first, last } = panel();
    first.focus();

    tab(container, true);

    expect(document.activeElement).toBe(last);
  });

  it('leaves Tab between inner stops to the browser', () => {
    const { container, middle } = panel();
    middle.focus();

    const event = tab(container);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(middle);
  });

  it('ignores every other key', () => {
    const { container, last } = panel();
    last.focus();
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });

    wrapFocus(container, event);

    expect(event.defaultPrevented).toBe(false);
  });
});
