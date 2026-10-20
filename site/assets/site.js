// Copy buttons on the code panels. Without script the buttons stay hidden and the
// commands remain selectable text.
for (const button of document.querySelectorAll('[data-copy]')) {
  const source = document.getElementById(button.dataset.copy);
  if (!source || !navigator.clipboard) continue;
  const label = button.querySelector('[data-label]');
  const idle = label.textContent;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(source.innerText.trim());
      label.textContent = button.dataset.done;
    } catch {
      label.textContent = button.dataset.failed;
    }
    setTimeout(() => {
      label.textContent = idle;
    }, 2000);
  });
}

// Close the small-screen menu after a link in it is followed.
for (const link of document.querySelectorAll('.menu-panel a')) {
  link.addEventListener('click', () => link.closest('details')?.removeAttribute('open'));
}

// Let blocks rise into place as they scroll into view. Only blocks that start
// below the fold are held back, so nothing on screen disappears, and with
// reduced motion or without IntersectionObserver nothing is held back at all.
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
    { rootMargin: '0px 0px -10% 0px' },
  );
  for (const block of document.querySelectorAll('.reveal')) {
    if (block.getBoundingClientRect().top < window.innerHeight) continue;
    block.classList.add('is-pending');
    observer.observe(block);
  }
}
