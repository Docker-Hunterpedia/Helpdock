import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// The screens render after their api calls settle, and a loaded CI runner can
// take more than Testing Library's default second to get there. The budget is
// per query, so a healthy run still finishes as soon as the element appears.
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  // The preferences are read from storage at mount, so a locale left behind by
  // one test would decide the next one's direction.
  localStorage.clear();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
});

afterEach(() => {
  cleanup();
});
