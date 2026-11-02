import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRouteScroll } from './route-scroll.js';

/** A new route opens at the top; Back and Forward and the workspace are left alone. */

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/reports']}>{children}</MemoryRouter>
);

describe('useRouteScroll', () => {
  const scrollTo = vi.fn();

  beforeEach(() => {
    scrollTo.mockClear();
    vi.stubGlobal('scrollTo', scrollTo);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mount = (flush: boolean) =>
    renderHook(
      () => {
        useRouteScroll(flush);
        return useNavigate();
      },
      { wrapper },
    );

  it('leaves the first render alone and scrolls to the top for a new route', () => {
    const { result } = mount(false);
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => {
      void result.current('/contacts');
    });

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('does not scroll for a Back or Forward navigation', () => {
    const { result } = mount(false);
    act(() => {
      void result.current('/contacts');
    });
    scrollTo.mockClear();

    act(() => {
      void result.current(-1);
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does not touch the window in the ticket workspace, which scrolls inside its panes', () => {
    const { result } = mount(true);

    act(() => {
      void result.current('/tickets/abc');
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
