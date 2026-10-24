import { createContext, useContext } from 'react';

/**
 * What the Settings shell tells a page's header (M14-21): the breadcrumb, and
 * the entry's own name as the title where the page is the entry itself. Absent
 * outside the shell, where a header is the plain h1 and caption it always was.
 */
export interface SettingsHeader {
  /** The crumbs before the title, drawn `Settings › Inbox`. */
  readonly crumbs: readonly string[];
  /** The navigation entry's label; undefined on a page deeper than an entry. */
  readonly title: string | undefined;
}

export const SettingsHeaderContext = createContext<SettingsHeader | null>(null);

export const useSettingsHeader = (): SettingsHeader | null => useContext(SettingsHeaderContext);
