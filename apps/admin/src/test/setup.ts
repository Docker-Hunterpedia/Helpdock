import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { SIDEBAR_STORAGE_KEY } from '../shell/sidebar-collapse.js';

// The screens render after their api calls settle, and a loaded CI runner can
// take more than Testing Library's default second to get there. The budget is
// per query, so a healthy run still finishes as soon as the element appears.
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  // The preferences are read from storage at mount, so a locale left behind by
  // one test would decide the next one's direction.
  localStorage.clear();
  // happy-dom's window is 1024 px wide, where the sidebar would open as the
  // collapsed rail; the screens are tested against the expanded one, as the
  // Playwright viewport shows it. The rail has tests of its own.
  localStorage.setItem(SIDEBAR_STORAGE_KEY, 'expanded');
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
});

afterEach(() => {
  cleanup();
});
