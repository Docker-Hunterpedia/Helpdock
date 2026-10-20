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
