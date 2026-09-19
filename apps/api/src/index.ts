/**
 * The app's entry points, for a host that embeds it rather than running
 * `main.ts`: the integration tests do exactly that, and M0-09 may. Everything
 * else — the guards, the decorators, the request context — is imported from its
 * own module, because `apps/*` are never imported by anything but themselves
 * (ARCHITECTURE §2) and a barrel of the whole app would only hide that.
 */
export const PACKAGE_NAME = '@helpdock/api' as const;

export { AppModule, type AppModuleOptions } from './app.module.js';
export { type ApiApp, createApiApp, createRuntime, type Runtime, start } from './bootstrap.js';
