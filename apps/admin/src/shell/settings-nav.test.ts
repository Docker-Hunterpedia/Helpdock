import { Settings } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { ROUTES } from '../app/route-paths.js';
import {
  entriesFor,
  firstSettingsPath,
  SETTINGS_ENTRIES,
  SETTINGS_GROUP_ICONS,
  SETTINGS_GROUPS,
  type SettingsViewer,
  settingsEntryAt,
  settingsFor,
} from './settings-nav.js';

const installAdmin: SettingsViewer = { role: 'admin', installAdmin: true };
const admin: SettingsViewer = { role: 'admin', installAdmin: false };
const leader: SettingsViewer = { role: 'teamLeader', installAdmin: false };
const agent: SettingsViewer = { role: 'agent', installAdmin: false };
const viewer: SettingsViewer = { role: 'viewer', installAdmin: false };

const groups = (who: SettingsViewer): Record<string, string[]> =>
  Object.fromEntries(
    settingsFor(who).map(({ group, entries }) => [group, entries.map((entry) => entry.id)]),
  );

describe('settingsFor', () => {
  it('offers an install admin the seven groups, in the board’s order', () => {
    expect(settingsFor(installAdmin).map(({ group }) => group)).toEqual([
      'account',
      'brand',
      'inbox',
      'channels',
      'ai',
      'developers',
      'install',
    ]);
  });

  it('offers a brand admin everything except what is install-wide', () => {
    const offered = groups(admin);

    expect(offered.install).toEqual(['staff', 'brandImport']);
    expect(offered.ai).toEqual(['aiKnowledge', 'aiAssistant']);
    expect(offered.developers).toEqual(['developersApi', 'developersWebhooks']);
    expect(offered.brand).toEqual([
      'brandGeneral',
      'brandDomains',
      'brandRetention',
      'brandDanger',
    ]);
  });

  it('offers a team leader what the old pages did and no more', () => {
    const offered = groups(leader);

    expect(offered.brand).toBeUndefined();
    expect(offered.developers).toBeUndefined();
    expect(offered.channels).toEqual(['channelsWidget']);
    expect(offered.ai).toEqual(['aiKnowledge', 'aiAssistant']);
    expect(offered.install).toEqual(['staff']);
    expect(offered.inbox).toEqual(expect.arrayContaining(['ticketingSlas', 'automationRules']));
  });

  it('offers an agent their account and the macros', () => {
    expect(groups(agent)).toEqual({
      account: ['accountProfile', 'yourNotifications', 'accountSecurity', 'accountSignature'],
      inbox: ['automationMacros'],
    });
  });

  it('offers a viewer their account alone', () => {
    expect(Object.keys(groups(viewer))).toEqual(['account']);
  });

  it('has no entry in two groups, no path twice, and a group for each', () => {
    expect(new Set(SETTINGS_ENTRIES.map((entry) => entry.id)).size).toBe(SETTINGS_ENTRIES.length);
    expect(new Set(SETTINGS_ENTRIES.map((entry) => entry.path)).size).toBe(SETTINGS_ENTRIES.length);
    expect(entriesFor('install', installAdmin).map((entry) => entry.id)).toEqual([
      'settings',
      'sso',
      'staff',
      'system',
      'systemAuditLog',
      'systemQueues',
      'brandImport',
    ]);
  });
});

describe('firstSettingsPath', () => {
  it('lands where the person has a page', () => {
    expect(firstSettingsPath(viewer)).toBe(ROUTES.meProfile);
    expect(firstSettingsPath(agent, 'inbox')).toBe('/settings/inbox/macros');
    expect(firstSettingsPath(leader, 'channels')).toBe('/settings/channels/widget');
    expect(firstSettingsPath(admin, 'ai')).toBe('/settings/ai/knowledge');
  });

  it('falls back to Profile for a group the person has nothing in', () => {
    expect(firstSettingsPath(viewer, 'developers')).toBe(ROUTES.meProfile);
  });
});

describe('settingsEntryAt', () => {
  it.each([
    ['/settings/inbox/slas', 'ticketingSlas'],
    ['/settings/inbox/rules/0192c3f0', 'automationRules'],
    ['/settings/channels/mailboxes/new', 'channelsMailboxes'],
    ['/settings/channels/telegram/0192c3f0', 'channelsTelegram'],
    ['/settings/install/sso/0192c3f0', 'sso'],
    ['/settings/install/system/audit-log', 'systemAuditLog'],
    ['/settings/install/imports/0192c3f0', 'brandImport'],
  ])('puts %s under %s', (path, id) => {
    expect(settingsEntryAt(path)?.id).toBe(id);
  });

  it('knows no entry for the shell’s own path or another area', () => {
    expect(settingsEntryAt('/settings')).toBeUndefined();
    expect(settingsEntryAt('/settings/inbox')).toBeUndefined();
    expect(settingsEntryAt('/tickets')).toBeUndefined();
  });
});

describe('the icons of the Settings tree', () => {
  it('gives every group an icon, and no two groups the same one', () => {
    const icons = SETTINGS_GROUPS.map((group) => SETTINGS_GROUP_ICONS[group]);
    expect(icons.every((icon) => icon !== undefined)).toBe(true);
    expect(new Set(icons).size).toBe(SETTINGS_GROUPS.length);
  });

  it('gives every page its own icon rather than the fallback gear, unique within its group', () => {
    for (const group of SETTINGS_GROUPS) {
      const entries = SETTINGS_ENTRIES.filter((candidate) => candidate.group === group);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.icon, entry.id).not.toBe(Settings);
      }
      expect(new Set(entries.map((entry) => entry.icon)).size, group).toBe(entries.length);
    }
  });

  it('lists the audit log and the queues as pages of Install', () => {
    const install = SETTINGS_ENTRIES.filter((entry) => entry.group === 'install').map(
      (entry) => entry.id,
    );
    expect(install).toEqual(
      expect.arrayContaining(['system', 'systemAuditLog', 'systemQueues', 'brandImport']),
    );
    expect(settingsEntryAt(ROUTES.systemQueues)?.id).toBe('systemQueues');
    expect(settingsEntryAt(ROUTES.systemAuditLog)?.id).toBe('systemAuditLog');
  });
});
