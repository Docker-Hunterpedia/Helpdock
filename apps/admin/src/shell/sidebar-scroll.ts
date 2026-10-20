import { useLayoutEffect, useRef, useState } from 'react';

/** Tracks clipped edges after scrolling, resizing, or asynchronous Views updates. */
export function useSidebarScroll() {
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  useLayoutEffect(() => {
    const nav = navRef.current;
    const content = contentRef.current;
    if (nav === null || content === null) return;

    const update = () => {
      // Safari can overscroll past either edge; fractional bottom pixels are rounded.
      const top = nav.scrollTop > 1;
      const bottom = nav.scrollHeight - nav.clientHeight - nav.scrollTop > 1;
      setEdges((previous) =>
        previous.top === top && previous.bottom === bottom ? previous : { top, bottom },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    observer.observe(content);
    nav.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      nav.removeEventListener('scroll', update);
    };
  }, []);

  return { navRef, contentRef, edges };
}
