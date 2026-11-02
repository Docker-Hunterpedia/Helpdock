import { useEffect } from 'react';

export const APP_TITLE = 'Helpdock';

/** `<page> · Helpdock`, so a tab or a history entry says where it is. */
export const pageTitle = (page: string | undefined): string =>
  page === undefined || page.trim() === '' ? APP_TITLE : `${page.trim()} · ${APP_TITLE}`;

/** Sets the browser tab title for the page on screen. */
export function usePageTitle(page: string | undefined): void {
  useEffect(() => {
    document.title = pageTitle(page);
  }, [page]);
}
