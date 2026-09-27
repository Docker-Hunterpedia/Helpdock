import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { autoPlace, defineWidgetElement, ELEMENT_NAME, installCommandApi } from './embed.js';
import { sampleMockOptions } from './transport/fixtures.js';
import { MockTransport } from './transport/mock.js';

const transports: MockTransport[] = [];

beforeAll(() => {
  defineWidgetElement({
    createTransport: () => {
      const transport = new MockTransport(sampleMockOptions('en'));
      transports.push(transport);
      return transport;
    },
    pageLocale: () => 'en-GB',
  });
});

afterEach(() => {
  document.body.replaceChildren();
  transports.length = 0;
});

const script = (brand?: string) => {
  const element = document.createElement('script');
  if (brand) {
    element.dataset.brand = brand;
    element.dataset.locale = 'ar';
  }
  return element;
};

describe('autoPlace', () => {
  it('adds one <helpdock-widget> for a script tag with data-brand', () => {
    autoPlace(script('acme'), document);
    autoPlace(script('acme'), document);

    const elements = document.querySelectorAll(ELEMENT_NAME);
    expect(elements).toHaveLength(1);
    expect(elements[0]?.getAttribute('brand')).toBe('acme');
    expect(elements[0]?.getAttribute('locale')).toBe('ar');
  });

  it('does nothing without data-brand, leaving placement to the page', () => {
    autoPlace(script(), document);

    expect(document.querySelector(ELEMENT_NAME)).toBeNull();
  });
});

describe('the element and the command API', () => {
  it('mounts on connect, replays queued commands, and forwards later ones (M4-02)', async () => {
    const identity = { user_id: 'u-42', email: 'omar@example.com', ts: 1, signature: 'abc' };
    const page: Record<string, unknown> = { Helpdock: { q: [['identify', identity]] } };
    installCommandApi(page);

    const element = document.createElement(ELEMENT_NAME);
    element.setAttribute('brand', 'acme');
    document.body.append(element);

    await vi.waitFor(() =>
      expect(
        transports[0]?.calls.filter((call) => call.method === 'startSession').length,
      ).toBeGreaterThan(0),
    );
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector('.hd-launcher')).toBeTruthy());

    (page.Helpdock as (...args: unknown[]) => void)('open');
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector('.hd-window')).toBeTruthy());
    (page.Helpdock as (...args: unknown[]) => void)('close');
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector('.hd-window')).toBeNull());

    const sessions = transports[0]?.calls.filter((call) => call.method === 'startSession') ?? [];
    expect(sessions.at(-1)?.args).toEqual([identity]);
  });

  it('does not mount without a brand, and unmounts when removed', async () => {
    const bare = document.createElement(ELEMENT_NAME);
    document.body.append(bare);
    expect(bare.shadowRoot).toBeNull();

    const element = document.createElement(ELEMENT_NAME);
    element.setAttribute('brand', 'acme');
    document.body.append(element);
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector('.hd-launcher')).toBeTruthy());

    element.remove();
    expect(element.shadowRoot?.querySelector('.hd-launcher')).toBeNull();
  });
});
