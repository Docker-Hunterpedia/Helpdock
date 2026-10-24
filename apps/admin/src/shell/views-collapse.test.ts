import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readViewsCollapsed,
  storeViewsCollapsed,
  useViewsCollapsed,
  viewsCollapseKey,
} from './views-collapse.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the Views group’s fold', () => {
  it('starts open and remembers a fold per person', () => {
    const lina = renderHook(() => useViewsCollapsed('lina'));
    expect(lina.result.current.collapsed).toBe(false);

    act(() => {
      lina.result.current.toggle();
    });

    expect(lina.result.current.collapsed).toBe(true);
    expect(localStorage.getItem(viewsCollapseKey('lina'))).toBe('collapsed');
    expect(readViewsCollapsed('lina')).toBe(true);
    expect(readViewsCollapsed('omar')).toBe(false);
    expect(renderHook(() => useViewsCollapsed('lina')).result.current.collapsed).toBe(true);
  });

  it('opens again on the next toggle', () => {
    storeViewsCollapsed('lina', true);
    const { result } = renderHook(() => useViewsCollapsed('lina'));

    act(() => {
      result.current.toggle();
    });

    expect(result.current.collapsed).toBe(false);
    expect(readViewsCollapsed('lina')).toBe(false);
  });

  it('still folds for the visit when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useViewsCollapsed('lina'));
    expect(result.current.collapsed).toBe(false);

    act(() => {
      result.current.toggle();
    });

    expect(result.current.collapsed).toBe(true);
  });
});
