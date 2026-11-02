import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/** Section targets arrive after asynchronous data; give them this long to appear. */
const HASH_WAIT_MS = 4000;
const HASH_POLL_MS = 100;
/** Space kept above a section a link scrolled to. */
const SCROLL_MARGIN = '16px';

const decodeFragment = (hash: string): string => {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * Scrolls to the element a `#fragment` names, waiting for it when the page is
 * still loading its data. Returns a function that stops waiting.
 */
export function scrollToHash(hash: string, waitMs: number = HASH_WAIT_MS): () => void {
  const id = decodeFragment(hash);
  if (id === '') {
    return () => undefined;
  }
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (): void => {
    const target = document.getElementById(id);
    if (target !== null) {
      target.style.scrollMarginBlockStart = SCROLL_MARGIN;
      target.scrollIntoView({ block: 'start' });
      return;
    }
    if (Date.now() - started < waitMs) {
      timer = setTimeout(attempt, HASH_POLL_MS);
    }
  };
  attempt();
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}

/**
 * A new route opens at the top of the page; a fragment scrolls to its section
 * (also on a direct load); going Back or Forward leaves the browser's own
 * restored position alone. `flush` pages scroll inside their own panes.
 */
export function useRouteScroll(flush: boolean): void {
  const { pathname, hash, key } = useLocation();
  const navigationType = useNavigationType();
  // The entry the app was opened on has the key `default`. A ref would not do:
  // StrictMode mounts, cleans up and mounts again, and the second pass would
  // no longer know it was the first.
  const initial = key === 'default';

  // biome-ignore lint/correctness/useExhaustiveDependencies: `navigationType` describes this navigation and must not retrigger on its own.
  useEffect(() => {
    if (!initial && navigationType === 'POP') {
      return undefined;
    }
    if (!flush && !initial) {
      window.scrollTo(0, 0);
    }
    return hash === '' ? undefined : scrollToHash(hash);
  }, [pathname, hash, flush, initial]);
}
