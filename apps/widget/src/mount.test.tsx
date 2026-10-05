import { afterEach, describe, expect, it, vi } from 'vitest';
import { changesOnly, mountWidget } from './mount.js';
import { sampleMockOptions } from './transport/fixtures.js';
import { MockTransport } from './transport/mock.js';

afterEach(() => {
  document.body.replaceChildren();
});

const mount = (locale: 'en' | 'ar', scheme: 'light' | 'dark' | 'auto' = 'light') => {
  const host = document.createElement('div');
  document.body.append(host);
  const widget = mountWidget(host, {
    transport: new MockTransport(sampleMockOptions(locale, { scheme })),
    locale,
  });
  return { host, widget };
};

describe('mountWidget', () => {
  it('renders into an open shadow root with the direction and language of the locale (M4-06)', async () => {
    const { host } = mount('ar');

    await vi.waitFor(() => expect(host.shadowRoot?.querySelector('.hd-launcher')).toBeTruthy());
    expect(host.getAttribute('dir')).toBe('rtl');
    expect(host.getAttribute('lang')).toBe('ar');
    expect(host.shadowRoot?.querySelector('[dir="rtl"]')).toBeTruthy();
    expect(host.shadowRoot?.querySelector('.hd-launcher')?.getAttribute('aria-label')).toBe(
      'فتح محادثة الدعم',
    );
  });

  it('paints the brand theme in the configured scheme and position', async () => {
    const { host } = mount('en', 'dark');

    await vi.waitFor(() => expect(host.dataset.scheme).toBe('dark'));
    expect(host.dataset.position).toBe('inline-end');
  });

  it('removes everything it drew on unmount', async () => {
    const { host, widget } = mount('en');
    await vi.waitFor(() => expect(host.shadowRoot?.querySelector('.hd-launcher')).toBeTruthy());

    widget.unmount();

    expect(host.shadowRoot?.querySelector('.hd-launcher')).toBeNull();
  });
});

describe('changesOnly', () => {
  it('passes a stylesheet on once until its text changes', () => {
    const apply = vi.fn();
    const setTheme = changesOnly(apply);

    setTheme(':host{--a:1}');
    setTheme(':host{--a:1}');
    setTheme(':host{--a:2}');

    expect(apply.mock.calls).toEqual([[':host{--a:1}'], [':host{--a:2}']]);
  });
});
