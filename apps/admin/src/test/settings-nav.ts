import { screen, within } from '@testing-library/react';

/**
 * A page of the Settings tree in the main sidebar, by its visible name. The
 * tree keeps closed groups mounted but hidden, so the lookup includes them: a
 * test asks what the page's link says, and the sidebar tests ask what is open.
 */
export const settingsLink = (name: string | RegExp): HTMLElement =>
  within(screen.getByRole('list', { name: 'Settings', hidden: true })).getByRole('link', {
    name,
    hidden: true,
  });

/** The Settings tree's page links, in order, open groups and closed alike. */
export const settingsLinks = (): string[] =>
  within(screen.getByRole('list', { name: 'Settings', hidden: true }))
    .getAllByRole('link', { hidden: true })
    .map((link) => link.textContent ?? '');
