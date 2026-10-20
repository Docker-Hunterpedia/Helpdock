import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSidebarShortcut,
  readSidebarChoice,
  SIDEBAR_STORAGE_KEY,
  useSidebarCollapse,
} from './sidebar-collapse.js';

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

describe('isSidebarShortcut', () => {
  it.each([
    { case: '⌘\\', keys: { key: '\\', code: 'Backslash', metaKey: true }, toggles: true },
    { case: 'Ctrl+\\', keys: { key: '\\', code: 'Backslash', ctrlKey: true }, toggles: true },
    // The same physical key on an Arabic layout types another character.
    {
      case: 'Ctrl+\\ on Arabic',
      keys: { key: 'ذ', code: 'Backslash', ctrlKey: true },
      toggles: true,
    },
    {
      case: 'a layout with \\ elsewhere',
      keys: { key: '\\', code: 'IntlBackslash', metaKey: true },
      toggles: true,
    },
    { case: '\\ alone', keys: { key: '\\', code: 'Backslash' }, toggles: false },
    {
      case: 'Ctrl+Shift+\\',
      keys: { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true },
      toggles: false,
    },
    {
      case: 'Ctrl+Alt+\\',
      keys: { key: '\\', code: 'Backslash', ctrlKey: true, altKey: true },
      toggles: false,
    },
    { case: 'Ctrl+K', keys: { key: 'k', code: 'KeyK', ctrlKey: true }, toggles: false },
  ])('$case toggles: $toggles', ({ keys, toggles }) => {
    expect(isSidebarShortcut(keys)).toBe(toggles);
  });
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

      const { result } = renderHook(() => useSidebarCollapse({ shortcut: true }));

      expect(result.current.collapsed).toBe(collapsed);
    },
  );

  it('keeps the choice made, over the viewport, and remembers a new one', () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, 'collapsed');
    viewport(1440);
    const { result } = renderHook(() => useSidebarCollapse({ shortcut: true }));

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
    const { result } = renderHook(() => useSidebarCollapse({ shortcut: true }));

    act(() => {
      result.current.toggle();
    });

    expect(result.current.collapsed).toBe(true);
  });

  it('answers ⌘\\ only where the sidebar is a column', () => {
    viewport(1440);
    const column = renderHook(() => useSidebarCollapse({ shortcut: true }));
    const drawer = renderHook(() => useSidebarCollapse({ shortcut: false }));

    const press = new KeyboardEvent('keydown', {
      key: '\\',
      code: 'Backslash',
      ctrlKey: true,
      cancelable: true,
    });
    act(() => {
      fireEvent(window, press);
    });

    expect(column.result.current.collapsed).toBe(true);
    expect(press.defaultPrevented).toBe(true);
    expect(drawer.result.current.collapsed).toBe(false);
  });
});
