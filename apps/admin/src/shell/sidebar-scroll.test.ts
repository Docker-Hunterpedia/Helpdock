import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSidebarScroll } from './sidebar-scroll.js';

afterEach(() => vi.unstubAllGlobals());

describe('sidebar scroll cues (#340)', () => {
  it('updates clipped edges on scroll and content/viewport resize, and cleans up', () => {
    let resize = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const nav = document.createElement('nav');
    const content = document.createElement('div');
    nav.append(content);
    Object.defineProperties(nav, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
    });
    const { result, unmount } = renderHook(() => {
      const scroll = useSidebarScroll();
      scroll.navRef.current = nav;
      scroll.contentRef.current = content;
      return scroll;
    });
    expect(result.current.edges).toEqual({ top: false, bottom: true });
    act(() => {
      nav.scrollTop = 80;
      nav.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.edges).toEqual({ top: true, bottom: true });
    act(() => {
      nav.scrollTop = 199.5;
      nav.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.edges).toEqual({ top: true, bottom: false });
    act(() => {
      nav.scrollTop = -10;
      nav.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.edges).toEqual({ top: false, bottom: true });
    act(() => {
      nav.scrollTop = 0;
      Object.defineProperty(nav, 'scrollHeight', { value: 80 });
      resize();
    });
    expect(result.current.edges).toEqual({ top: false, bottom: false });
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
