// Progressive touches only: every page reads and works without this script.

// Copy buttons: `data-copy` names an element whose text is copied (the install
// commands), `data-copy-text` carries the text itself (a release's link), and
// `data-copy-url` names a same-origin file to copy (a guide's Markdown).
// Without script they stay hidden and the text remains selectable.
async function copyFrom(button: HTMLButtonElement): Promise<void> {
  const { copy, copyText, copyUrl } = button.dataset;
  if (copyUrl) {
    const text = fetch(copyUrl).then(async (response) => {
      if (!response.ok) throw new Error(`${copyUrl} answered ${response.status}`);
      // The clipboard takes a blob only when its type matches the key it is filed under.
      return new Blob([await response.text()], { type: 'text/plain' });
    });
    // A ClipboardItem keeps the click's permission while the file loads (Safari).
    if ('ClipboardItem' in window) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })]);
    } else {
      await navigator.clipboard.writeText(await (await text).text());
    }
    return;
  }
  const source = copyText ?? document.getElementById(copy ?? '')?.innerText.trim();
  if (source === undefined) throw new Error('nothing to copy');
  await navigator.clipboard.writeText(source);
}

for (const button of document.querySelectorAll<HTMLButtonElement>(
  '[data-copy], [data-copy-text], [data-copy-url]',
)) {
  const label = button.querySelector('[data-label]');
  if (!label || !navigator.clipboard) continue;
  const idle = label.textContent;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await copyFrom(button);
      label.textContent = button.dataset.done ?? idle;
    } catch {
      label.textContent = button.dataset.failed ?? idle;
    }
    setTimeout(() => {
      label.textContent = idle;
    }, 2000);
  });
}

// Disclosure menus (the phone menu, a guide's AI actions) close on Escape and
// on a click elsewhere, and the phone menu after one of its links is followed.
const menus = document.querySelectorAll<HTMLDetailsElement>('details.menu, details.doc-actions');
for (const menu of menus) {
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menu.querySelector('summary')?.focus();
  });
}
document.addEventListener('click', (event) => {
  for (const menu of menus) {
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
  }
});
for (const link of document.querySelectorAll('.menu-panel a')) {
  link.addEventListener('click', () => link.closest('details')?.removeAttribute('open'));
}

// The docs sidebar folds on narrow screens (it is open in the markup, so it
// works without script) and keeps the current guide in view in its own scroll.
const docsNav = document.querySelector<HTMLElement>('.docs-nav');
if (docsNav) {
  const fold = docsNav.querySelector('details');
  if (fold && !window.matchMedia('(min-width: 900px)').matches) fold.open = false;
  const current = docsNav.querySelector<HTMLElement>('[aria-current="page"]');
  if (current && docsNav.scrollHeight > docsNav.clientHeight) {
    docsNav.scrollTop = current.offsetTop - docsNav.clientHeight / 2;
  }
}

// Blocks rise into place the first time they scroll into view. Only blocks that
// start below the fold are held back, and with reduced motion or without
// IntersectionObserver nothing is held back at all.
const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!calm && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove('is-pending');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (const block of document.querySelectorAll('.reveal')) {
    if (block.getBoundingClientRect().top < window.innerHeight) continue;
    block.classList.add('is-pending');
    observer.observe(block);
  }
}
