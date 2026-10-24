import { screen, within } from '@testing-library/react';

/** A link in the Settings area's navigation (M14-21), by its visible name. */
export const settingsLink = (name: string | RegExp): HTMLElement =>
  within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('link', { name });

/** The Settings navigation's links, in order. */
export const settingsLinks = (): string[] =>
  within(screen.getByRole('navigation', { name: 'Settings' }))
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');
