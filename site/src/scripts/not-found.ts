// The 404 page: "did you mean" from the known routes, and the site search run
// on the best suggestion's title (or the address's words), its top results
// shown inline.

import { type KnownRoute, notFoundHelp } from '../lib/suggest.ts';
import { excerpt, icon, loadPagefind, pageIcon, span } from './pagefind.ts';

const INLINE_RESULTS = 5;
const locale = document.documentElement.lang === 'ar' ? 'ar' : 'en';
const section = document.querySelector<HTMLElement>(`[data-not-found="${locale}"]`);
const path = location.pathname;

const isRoute = (value: unknown): value is KnownRoute =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as KnownRoute).path === 'string' &&
  typeof (value as KnownRoute).title === 'string';

function routes(): KnownRoute[] {
  try {
    const parsed: unknown = JSON.parse(document.getElementById('nf-routes')?.textContent ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isRoute) : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

const help = notFoundHelp(path, routes());

function showSuggestions(root: HTMLElement) {
  const box = root.querySelector<HTMLElement>('[data-nf-suggest]');
  const list = root.querySelector<HTMLUListElement>('[data-nf-suggest-list]');
  if (!box || !list || help.suggestions.length === 0) return;
  list.replaceChildren(
    ...help.suggestions.map(({ path: route }) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = route;
      link.className = 'nf-suggestion';
      const code = document.createElement('code');
      code.className = 'nf-code';
      code.textContent = route;
      const isolate = document.createElement('bdi');
      isolate.append(code);
      link.append(icon(pageIcon(route)), isolate);
      item.append(link);
      return item;
    }),
  );
  box.hidden = false;
}

function setUpSearch(root: HTMLElement) {
  const form = root.querySelector<HTMLFormElement>('[data-nf-search]');
  const input = root.querySelector<HTMLInputElement>('[data-nf-input]');
  const status = root.querySelector<HTMLElement>('[data-nf-status]');
  const list = root.querySelector<HTMLUListElement>('[data-nf-results]');
  const everything = root.querySelector<HTMLButtonElement>('[data-nf-everything]');
  if (!form || !input || !status || !list || !everything) return;

  const say = (key: 'loading' | 'count' | 'none' | 'offline', query = '') => {
    status.textContent = (form.dataset[key] ?? '').replace('{q}', query);
  };
  const remember = () => {
    everything.dataset.searchQuery = input.value;
  };

  let latest = 0;
  const run = async (query: string) => {
    const ticket = ++latest;
    if (query.trim() === '') {
      list.replaceChildren();
      status.textContent = '';
      return;
    }
    say('loading');
    try {
      const found = await (await loadPagefind()).search(query);
      const results = await Promise.all(
        found.results.slice(0, INLINE_RESULTS).map((result) => result.data()),
      );
      if (ticket !== latest) return;
      list.replaceChildren(
        ...results.map((result) => {
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = result.url;
          link.className = 'nf-result';
          link.append(
            icon(pageIcon(result.url)),
            span('search-title', result.meta.title ?? result.url),
            excerpt(result.excerpt),
          );
          item.append(link);
          return item;
        }),
      );
      say(results.length === 0 ? 'none' : 'count', query);
    } catch {
      if (ticket !== latest) return;
      list.replaceChildren();
      say('offline');
    }
  };

  input.value = help.query;
  remember();
  input.addEventListener('input', remember);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run(input.value);
  });
  if (input.value === '') return;
  // Pagefind loads after the page has painted, never in its way.
  const start = () => void run(input.value);
  if ('requestIdleCallback' in window) window.requestIdleCallback(start, { timeout: 1500 });
  else setTimeout(start, 200);
}

if (section) {
  showSuggestions(section);
  setUpSearch(section);
}
