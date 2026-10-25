// Progressive touches only: every page reads and works without this script.

// Copy buttons on code panels. Without script they stay hidden and the commands
// remain selectable text.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  const source = document.getElementById(button.dataset.copy ?? '');
  const label = button.querySelector('[data-label]');
  if (!source || !label || !navigator.clipboard) continue;
  const idle = label.textContent;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(source.innerText.trim());
      label.textContent = button.dataset.done ?? idle;
    } catch {
      label.textContent = button.dataset.failed ?? idle;
    }
    setTimeout(() => {
      label.textContent = idle;
    }, 2000);
  });
}

// Close the small-screen menu after one of its links is followed.
for (const link of document.querySelectorAll('.menu-panel a')) {
  link.addEventListener('click', () => link.closest('details')?.removeAttribute('open'));
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
