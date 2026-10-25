import { defineProject } from 'vitest/config';

// The website's pure modules only; pages are checked by `astro build`.
export default defineProject({
  test: {
    name: '@helpdock/website',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
