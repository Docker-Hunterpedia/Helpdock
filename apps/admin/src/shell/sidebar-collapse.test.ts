import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSidebarChoice, SIDEBAR_STORAGE_KEY, useSidebarCollapse } from './sidebar-collapse.js';

/** A viewport `width` px wide, as the one media query the hook asks sees it. */
const viewport = (width: number): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(min-width:1280px)' && width >= 1280,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('readSidebarChoice', () => {
  it('is no choice when storage throws or holds something else', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'sideways');
    expect(readSidebarChoice()).toBeNull();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readSidebarChoice()).toBeNull();
  });
});

describe('useSidebarCollapse', () => {
  it.each([
    { width: 1440, collapsed: false },
    { width: 1100, collapsed: true },
  ])(
    'opens a $width px viewport with no choice made as collapsed: $collapsed',
    ({ width, collapsed }) => {
      localStorage.removeItem(SIDEBAR_STORAGE_KEY);
      viewport(width);

      const { result } = renderHook(() => useSidebarCollapse());

      expect(result.current.collapsed).toBe(collapsed);
    },
  );

  it('keeps the choice made, over the viewport, and remembers a new one', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    viewport(1440);
    const { result } = renderHook(() => useSidebarCollapse());

    expect(result.current.collapsed).toBe(true);
    act(() => {
      result.current.toggle();
    });

    expect(result.current.collapsed).toBe(false);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('expanded');
  });

  it('still toggles when the choice cannot be stored', () => {
    viewport(1440);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useSidebarCollapse());

    act(() => {
      result.current.toggle();
    });

    expect(result.current.collapsed).toBe(true);
  });
});
