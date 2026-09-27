import { pickLocale } from './i18n/catalogs.js';
import { type MountedWidget, mountWidget } from './mount.js';
import type { SignedIdentity, WidgetTransport } from './transport/types.js';

/**
 * The embed API (`apps/widget/README.md`):
 *
 *   <script type="module" src="https://support.example.com/widget.js" data-brand="acme"></script>
 *   <script>window.Helpdock = window.Helpdock || function () { (Helpdock.q = Helpdock.q || []).push(arguments) };</script>
 *   <script>Helpdock('identify', { user_id, email, name, ts, signature });</script>
 *   <script>Helpdock('open', { article: '<article id>' });</script>   // "Still need help?" (M5-08)
 *
 * The script defines `<helpdock-widget>` and adds one to the page when the tag
 * carries `data-brand` and the page has none. Commands queued before the
 * module ran are replayed in order.
 */
export const ELEMENT_NAME = 'helpdock-widget';

type QueuedCommands = { q?: ArrayLike<unknown>[] };

export interface EmbedOptions {
  readonly createTransport: (brand: string) => WidgetTransport;
  /** The page's language, used when neither the element nor the script names one. */
  readonly pageLocale: () => string | null;
}

const mounted = new Set<MountedWidget>();
let pendingIdentity: SignedIdentity | null = null;
let pendingArticle: string | null = null;

/**
 * M5-08: `Helpdock('open', { article: '<id>' })` — "Still need help?" on a help
 * center article. Only an id-shaped string is taken; the api checks the rest.
 */
export const articleOf = (payload: unknown): string | null => {
  const article = (payload as { article?: unknown } | null | undefined)?.article;
  return typeof article === 'string' && /^[0-9a-f-]{36}$/i.test(article) ? article : null;
};

export function runCommand([name, payload]: readonly unknown[]): void {
  const article = name === 'open' ? articleOf(payload) : null;
  for (const widget of mounted) {
    if (name === 'identify') {
      void widget.controller.identify(payload as SignedIdentity).catch(() => undefined);
    } else if (name === 'open' || name === 'close') {
      if (article !== null) {
        widget.controller.setArticleContext(article);
      }
      widget.controller.setOpen(name === 'open');
    }
  }
  if (name === 'identify') {
    pendingIdentity = payload as SignedIdentity;
  }
  if (article !== null) {
    pendingArticle = article;
  }
}

export function defineWidgetElement(options: EmbedOptions): void {
  if (customElements.get(ELEMENT_NAME)) {
    return;
  }
  customElements.define(
    ELEMENT_NAME,
    class HelpdockWidget extends HTMLElement {
      #widget: MountedWidget | null = null;

      connectedCallback() {
        const brand = this.getAttribute('brand');
        if (!brand || this.#widget) {
          return;
        }
        const locale = pickLocale(this.getAttribute('locale') ?? options.pageLocale(), 'en');
        this.#widget = mountWidget(this, { transport: options.createTransport(brand), locale });
        mounted.add(this.#widget);
        if (pendingIdentity) {
          void this.#widget.controller.identify(pendingIdentity).catch(() => undefined);
        }
        if (pendingArticle) {
          this.#widget.controller.setArticleContext(pendingArticle);
        }
      }

      disconnectedCallback() {
        if (this.#widget) {
          mounted.delete(this.#widget);
          this.#widget.unmount();
          this.#widget = null;
        }
      }
    },
  );
}

/** Replaces the page's command-queue stub with the real dispatcher and drains the queue. */
export function installCommandApi(target: Record<string, unknown>): void {
  const stub = target.Helpdock as QueuedCommands | undefined;
  const queued = stub?.q ?? [];
  target.Helpdock = (...args: unknown[]) => runCommand(args);
  for (const args of queued) {
    runCommand(Array.from(args));
  }
}

/** Adds `<helpdock-widget>` for a `<script data-brand>` when the page did not place one itself. */
export function autoPlace(script: HTMLScriptElement | null, document: Document): void {
  const brand = script?.dataset.brand;
  if (!brand || document.querySelector(ELEMENT_NAME)) {
    return;
  }
  const element = document.createElement(ELEMENT_NAME);
  element.setAttribute('brand', brand);
  if (script.dataset.locale) {
    element.setAttribute('locale', script.dataset.locale);
  }
  document.body.append(element);
}
