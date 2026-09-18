/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Which `AuthApi` the app is built with. `mock` runs the in-memory fixture,
   * `http` the real service from M0-05. Unset means `mock` in dev and test and
   * `http` in a production build; see `src/auth/select-api.ts`.
   */
  readonly VITE_AUTH_API?: 'mock' | 'http';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
