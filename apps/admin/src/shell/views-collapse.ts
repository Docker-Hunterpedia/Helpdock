import { useCallback, useState } from 'react';

/**
 * Whether the sidebar's Views group is folded (M14-21). The choice is the
 * person's, so it is kept under their id in this browser's `localStorage`, the
 * way the sidebar's own collapse is; a read or write that throws is ignored and
 * the group simply stays open.
 */
export const viewsCollapseKey = (userId: string): string => `helpdock.admin.views.${userId}`;

export function readViewsCollapsed(userId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(viewsCollapseKey(userId)) === 'collapsed';
  } catch {
    return false;
  }
}

export function storeViewsCollapsed(userId: string, collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(viewsCollapseKey(userId), collapsed ? 'collapsed' : 'open');
  } catch {
    // Not remembering the choice is better than failing the toggle.
  }
}

export function useViewsCollapsed(userId: string): {
  readonly collapsed: boolean;
  readonly toggle: () => void;
} {
  const [collapsed, setCollapsed] = useState(() => readViewsCollapsed(userId));

  const toggle = useCallback(() => {
    setCollapsed(!collapsed);
    storeViewsCollapsed(userId, !collapsed);
  }, [userId, collapsed]);

  return { collapsed, toggle };
}
