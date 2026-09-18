import type { CatalogShape, DEFAULT_NS } from './resources.js';

/**
 * Makes `t('auth:signIn.title')` a compile-time check against the English
 * catalogs. Anything that imports `@helpdock/i18n` picks this up, so an app
 * never needs its own `i18next.d.ts`.
 *
 * `export {}` is load-bearing: without it this file is not a module and the
 * block below would replace i18next's own types instead of augmenting them.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NS;
    resources: CatalogShape;
    returnNull: false;
  }
}
