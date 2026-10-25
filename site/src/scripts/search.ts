// The site search: a command palette over Pagefind's index. A page that
// matches in several sections shows its title once, its sections under it.

import {
  excerpt,
  icon,
  loadPagefind,
  type PagefindResult,
  pageIcon,
  sectionsOf,
  span,
} from './pagefind.ts';

const MAX_PAGES = 8;
const MAX_SECTIONS = 3;

// The 404 page carries a dialog per language; the one in the page's language is used.
const dialog =
  document.querySelector<HTMLDialogElement>(
    `[data-search][data-locale="${document.documentElement.lang}"]`,
  ) ?? document.querySelector<HTMLDialogElement>('[data-search]');
const input = dialog?.querySelector<HTMLInputElement>('[data-search-input]');
const list = dialog?.querySelector<HTMLUListElement>('[data-search-results]');
const status = dialog?.querySelector<HTMLElement>('[data-search-status]');

let opener: HTMLElement | null = null;
let active = -1;

function say(
  key: 'hint' | 'loading' | 'none' | 'count' | 'offline',
  values: Record<string, string> = {},
) {
  if (!status || !dialog) return;
  let text = dialog.dataset[key] ?? '';
  for (const [name, value] of Object.entries(values)) text = text.replace(`{${name}}`, value);
  status.textContent = text;
}

function options(): HTMLLIElement[] {
  return [...(list?.querySelectorAll<HTMLLIElement>('[role="option"]') ?? [])];
}

function select(index: number, scroll = true) {
  const all = options();
  if (!input || all.length === 0) return;
  active = (index + all.length) % all.length;
  for (const [i, option] of all.entries()) {
    option.setAttribute('aria-selected', String(i === active));
  }
  const current = all[active];
  input.setAttribute('aria-activedescendant', current?.id ?? '');
  if (scroll) current?.scrollIntoView({ block: 'nearest' });
}

function option(id: string, className: string, href: string, parts: Node[]): HTMLLIElement {
  const item = document.createElement('li');
  item.id = id;
  item.className = className;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', 'false');
  const link = document.createElement('a');
  link.href = href;
  link.className = 'search-hit';
  link.tabIndex = -1;
  link.append(...parts);
  item.append(link);
  item.addEventListener('mousemove', () => {
    const index = options().indexOf(item);
    if (index !== active) select(index, false);
  });
  return item;
}

function rows(result: PagefindResult, page: number): HTMLLIElement[] {
  const title = result.meta.title ?? result.url;
  const sections = sectionsOf(result, MAX_SECTIONS);
  const head = option(`search-option-${page}`, 'search-page', result.url, [
    icon(pageIcon(result.url)),
    span('search-title', title),
    ...(sections.length === 0 ? [excerpt(result.excerpt)] : []),
  ]);
  return [
    head,
    ...sections.map((section, index) =>
      option(`search-option-${page}-${index}`, 'search-sub', section.url, [
        span('visually-hidden', `${title}: `),
        span('search-section', section.title),
        excerpt(section.excerpt),
      ]),
    ),
  ];
}

function render(results: PagefindResult[]) {
  if (!list || !input) return;
  list.replaceChildren(...results.flatMap(rows));
  active = -1;
  input.removeAttribute('aria-activedescendant');
  input.setAttribute('aria-expanded', String(results.length > 0));
  if (results.length > 0) select(0);
}

async function search(query: string) {
  if (query.trim() === '') {
    render([]);
    say('hint');
    return;
  }
  say('loading');
  try {
    const found = await (await loadPagefind()).debouncedSearch(query);
    if (found === null) return; // a newer query took over
    const results = await Promise.all(
      found.results.slice(0, MAX_PAGES).map((result) => result.data()),
    );
    render(results);
    if (results.length === 0) say('none', { q: query });
    else say('count', { n: String(found.results.length) });
  } catch {
    render([]);
    say('offline');
  }
}

function open(query?: string) {
  if (!dialog || !input || dialog.open) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.showModal();
  if (query !== undefined) {
    input.value = query;
    void search(query);
  }
  input.select();
  void loadPagefind().catch(() => say('offline'));
}

if (dialog && input) {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-search-open]')) {
    button.addEventListener('click', () => open(button.dataset.searchQuery));
  }
  dialog.querySelector('[data-search-close]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => opener?.focus());
  input.addEventListener('input', () => void search(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      select(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Escape') {
      // A search field spends the first Escape on clearing itself; here it closes.
      event.preventDefault();
      dialog.close();
    } else if (event.key === 'Enter') {
      const link = options()[active]?.querySelector('a');
      if (link) {
        event.preventDefault();
        link.click();
      }
    }
  });
  document.addEventListener('keydown', (event) => {
    const typing =
      event.target instanceof HTMLElement &&
      (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      open();
    } else if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      open();
    }
  });
}
