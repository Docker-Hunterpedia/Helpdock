import { describe, expect, it } from 'vitest';
import { tabForSegment, tabOfKind, tabsFor } from './tabs.js';

describe('tabsFor', () => {
  it('offers an Admin and a Team Leader every tab, in order', () => {
    expect(tabsFor('admin').map((tab) => tab.key)).toEqual(['rules', 'timeBased', 'macros']);
    expect(tabsFor('teamLeader').map((tab) => tab.key)).toEqual(['rules', 'timeBased', 'macros']);
  });

  it('offers an Agent Macros alone, and a Viewer nothing', () => {
    expect(tabsFor('agent').map((tab) => tab.key)).toEqual(['macros']);
    expect(tabsFor('viewer')).toEqual([]);
  });
});

describe('tabForSegment', () => {
  it('finds a tab the reader has by its url segment, and no other', () => {
    expect(tabForSegment(tabsFor('admin'), 'time-based')?.key).toBe('timeBased');
    expect(tabForSegment(tabsFor('agent'), 'rules')).toBeUndefined();
    expect(tabForSegment(tabsFor('admin'), undefined)).toBeUndefined();
  });
});

describe('tabOfKind', () => {
  it('puts a rule under the tab that lists its kind', () => {
    expect(tabOfKind('event').key).toBe('rules');
    expect(tabOfKind('scheduled').key).toBe('timeBased');
  });
});
