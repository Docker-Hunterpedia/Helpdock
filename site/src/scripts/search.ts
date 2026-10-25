// The site search: a dialog over Pagefind's static index, served from this
// origin. Pagefind's own script loads on the first open, never before.

type PagefindResult = {
  url: string;
  excerpt: string;
  meta: { title?: string };
  sub_results?: { title: string; url: string; excerpt: string }[];
};
type Pagefind = {
  init: () => Promise<void>;
  debouncedSearch: (
    query: string,
  ) => Promise<{ results: { data: () => Promise<PagefindResult> }[] } | null>;
};

const dialog = document.querySelector<HTMLDialogElement>('[data-search]');
const input = dialog?.querySelector<HTMLInputElement>('[data-search-input]');
const list = dialog?.querySelector<HTMLUListElement>('[data-search-results]');
const status = dialog?.querySelector<HTMLElement>('[data-search-status]');
const PAGEFIND = '/pagefind/pagefind.js';
const MAX_RESULTS = 8;

let pagefind: Promise<Pagefind> | undefined;
let opener: HTMLElement | null = null;
let active = -1;

function loadPagefind(): Promise<Pagefind> {
  pagefind ??= import(/* @vite-ignore */ PAGEFIND).then(async (module: Pagefind) => {
    await module.init();
    return module;
  });
  return pagefind;
}

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

function select(index: number) {
  const all = options();
  if (!input || all.length === 0) return;
  active = (index + all.length) % all.length;
  all.forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
  const current = all[active];
  input.setAttribute('aria-activedescendant', current?.id ?? '');
  current?.scrollIntoView({ block: 'nearest' });
}

function render(results: PagefindResult[]) {
  if (!list || !input) return;
  list.replaceChildren(
    ...results.map((result, index) => {
      const section = result.sub_results?.find((sub) => sub.url !== result.url);
      const item = document.createElement('li');
      item.id = `search-option-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      const link = document.createElement('a');
      link.href = section?.url ?? result.url;
      link.tabIndex = -1;
      const title = document.createElement('span');
      title.className = 'search-title';
      title.textContent = result.meta.title ?? result.url;
      link.append(title);
      if (section) {
        const where = document.createElement('span');
        where.className = 'search-section';
        where.textContent = section.title;
        link.append(where);
      }
      const excerpt = document.createElement('span');
      excerpt.className = 'search-excerpt';
      // Pagefind encodes the excerpt's text and adds only <mark>, so it is safe as HTML.
      excerpt.innerHTML = section?.excerpt ?? result.excerpt;
      link.append(excerpt);
      item.append(link);
      return item;
    }),
  );
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
      found.results.slice(0, MAX_RESULTS).map((result) => result.data()),
    );
    render(results);
    if (results.length === 0) say('none', { q: query });
    else say('count', { n: String(found.results.length) });
  } catch {
    render([]);
    say('offline');
  }
}

function open() {
  if (!dialog || !input || dialog.open) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.showModal();
  input.select();
  void loadPagefind().catch(() => say('offline'));
}

if (dialog && input) {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-search-open]')) {
    button.addEventListener('click', open);
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
