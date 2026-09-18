import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { EmptyState } from '../shell/empty-state.tsx';
import { NAV_BY_KEY, type NavKey } from '../shell/nav-items.js';
import { PageHeader } from '../shell/page-header.tsx';

/**
 * Every nav destination exists from day one so the shell can be navigated and
 * tested end to end. Each says what it will hold and which milestone brings it,
 * and nothing more: inventing a screen ahead of its deliverable is how a
 * milestone doc stops describing the product.
 */
export function PlaceholderPage({ navKey }: { readonly navKey: NavKey }): ReactNode {
  const t = useT();
  const item = NAV_BY_KEY[navKey];

  return (
    <>
      <PageHeader title={t(item.labelKey)} caption={t(item.captionKey)} />
      <EmptyState
        icon={item.icon}
        heading={t('admin:pages.empty.heading')}
        body={t(item.emptyKey)}
      />
    </>
  );
}
