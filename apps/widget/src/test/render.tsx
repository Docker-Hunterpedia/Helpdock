import { render } from '@testing-library/preact';
import { translatorFor } from '../i18n/catalogs.js';
import { WidgetController } from '../state/controller.js';
import { type SampleOptions, sampleMockOptions } from '../transport/fixtures.js';
import { type MockOptions, MockTransport } from '../transport/mock.js';
import type { WidgetLocale } from '../transport/types.js';
import { App } from '../ui/App.js';
import { WidgetContext } from '../ui/context.js';

/**
 * The widget as a component test sees it: the real App and controller over
 * the mock transport, rendered into the light DOM so Testing Library's
 * queries reach it (the shadow root is covered by `mount.test.tsx` and the
 * Playwright suite).
 */
export async function renderWidget(
  options: SampleOptions & { locale?: WidgetLocale; mock?: Partial<MockOptions> } = {},
) {
  const locale = options.locale ?? 'en';
  const mock = new MockTransport({ ...sampleMockOptions(locale, options), ...options.mock });
  const controller = new WidgetController(mock, locale);
  await controller.init();
  const view = render(
    <WidgetContext.Provider value={{ controller, t: translatorFor(locale), locale }}>
      <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
        <App />
      </div>
    </WidgetContext.Provider>,
  );
  return { ...view, mock, controller, t: translatorFor(locale) };
}
