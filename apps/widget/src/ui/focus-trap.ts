import { useEffect, useState } from 'preact/hooks';

/** The width below which the window fills the screen (`styles.css`, DESIGN §6.6). */
export const PHONE_QUERY = '(max-width: 480px)';

const TABBABLE =
  'input:not([type=hidden]):not([tabindex="-1"]):not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], [tabindex="0"]';

/** Whether the window currently fills the screen, following the viewport as it changes. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY);
    if (!media) {
      return;
    }
    const update = () => setPhone(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return phone;
}

/**
 * Keeps Tab inside `container`: from its last stop to its first, and with
 * Shift from its first to its last. The window does this only while it fills
 * the screen; on a wider screen it is a region beside a page that stays
 * usable, so Tab may leave it (DESIGN §10, M9-04).
 */
export function wrapFocus(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') {
    return;
  }
  const stops = [...container.querySelectorAll<HTMLElement>(TABBABLE)];
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) {
    return;
  }
  const root = container.getRootNode() as Document | ShadowRoot;
  const active = root.activeElement;
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
