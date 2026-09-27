import { autoPlace, defineWidgetElement, installCommandApi } from './embed.js';
import { createTransport } from './transport/create.js';

/**
 * `widget.js`. A module script has no `document.currentScript`, so the tag is
 * found by its own URL.
 */
const self = new URL(import.meta.url);
const script = [...document.querySelectorAll<HTMLScriptElement>('script[src]')].find(
  (candidate) => candidate.src === self.href,
);

defineWidgetElement({
  createTransport: (brand) => createTransport({ apiOrigin: self.origin, brand }),
  pageLocale: () => document.documentElement.lang || navigator.language,
});
installCommandApi(window as unknown as Record<string, unknown>);

if (document.body) {
  autoPlace(script ?? null, document);
} else {
  document.addEventListener('DOMContentLoaded', () => autoPlace(script ?? null, document), {
    once: true,
  });
}
