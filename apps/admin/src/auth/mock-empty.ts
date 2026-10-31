/**
 * Set to a JSON array before the app loads, it makes those parts of the
 * fixture read as a brand's first run (M14-23, `Admin/Empty-States`):
 * `["contacts", "macros", "rules", "helpCenter"]`. Browser tests use it because
 * the fixture's rows cannot all be deleted from the screen.
 */
export const MOCK_EMPTY_STORAGE = 'helpdock.mock.empty';

export type MockEmptyArea = 'contacts' | 'macros' | 'rules' | 'helpCenter';

export const isMockEmpty = (area: MockEmptyArea): boolean => {
  try {
    const stored: unknown = JSON.parse(
      globalThis.localStorage?.getItem(MOCK_EMPTY_STORAGE) ?? '[]',
    );
    return Array.isArray(stored) && stored.includes(area);
  } catch {
    return false;
  }
};
