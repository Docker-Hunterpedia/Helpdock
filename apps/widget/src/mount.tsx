import { render } from 'preact';
import { direction, translatorFor } from './i18n/catalogs.js';
import { WidgetController } from './state/controller.js';
import styles from './styles.css?inline';
import { registerFonts, resolveScheme, themeCss } from './theme.js';
import type { WidgetLocale, WidgetTransport } from './transport/types.js';
import { App } from './ui/App.js';
import { WidgetContext } from './ui/context.js';

export interface MountOptions {
  readonly transport: WidgetTransport;
  readonly locale: WidgetLocale;
}

export interface MountedWidget {
  readonly controller: WidgetController;
  unmount(): void;
}

/**
 * Constructable stylesheets are not subject to the host page's CSP
 * `style-src`, which a `<style>` element would be; the fallback is for
 * engines without them.
 */
function adopt(root: ShadowRoot, css: string): (next: string) => void {
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet !== 'undefined') {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return (next) => sheet.replaceSync(next);
  }
  const element = document.createElement('style');
  element.textContent = css;
  root.append(element);
  return (next) => {
    element.textContent = next;
  };
}

/** Renders the widget into `host`'s shadow root and starts talking to the server. */
export function mountWidget(host: HTMLElement, { transport, locale }: MountOptions): MountedWidget {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  const dir = direction(locale);
  host.setAttribute('dir', dir);
  host.setAttribute('lang', locale);
  adopt(root, styles);
  const setTheme = adopt(root, '');

  const controller = new WidgetController(transport, locale);
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  let fontsRegistered = false;

  const paint = () => {
    const theme = controller.state.config?.theme;
    if (!theme) {
      return;
    }
    const scheme = resolveScheme(theme.mode, media?.matches ?? false);
    host.dataset.scheme = scheme;
    host.dataset.position = theme.launcher.position;
    setTheme(themeCss(theme, scheme, dir === 'rtl'));
    if (!fontsRegistered) {
      fontsRegistered = true;
      registerFonts(theme, document.fonts);
    }
  };
  const stopPainting = controller.subscribe(paint);
  media?.addEventListener?.('change', paint);

  const mountPoint = document.createElement('div');
  mountPoint.setAttribute('dir', dir);
  root.append(mountPoint);
  render(
    <WidgetContext.Provider value={{ controller, t: translatorFor(locale), locale }}>
      <App />
    </WidgetContext.Provider>,
    mountPoint,
  );
  void controller.init();

  return {
    controller,
    unmount() {
      stopPainting();
      media?.removeEventListener?.('change', paint);
      render(null, mountPoint);
      mountPoint.remove();
      controller.destroy();
    },
  };
}
