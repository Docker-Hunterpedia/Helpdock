import type { StaffRole } from '@helpdock/schemas';
import { Bot, Database, type LucideIcon, Server } from 'lucide-react';

/**
 * The tab row of `Admin/AI` (DESIGN §6.5): Providers, Knowledge, Assistant.
 * Providers are install-wide, so only an install admin is offered them; the
 * other two are the brand's, for the roles that hold `ai:manage`. Like the
 * sidebar this is chrome: the api refuses whatever the row shows.
 */
export interface AiTab {
  readonly key: 'providers' | 'knowledge' | 'assistant';
  readonly segment: string;
  readonly icon: LucideIcon;
  readonly roles: readonly StaffRole[];
  readonly installAdminOnly: boolean;
}

export const AI_TABS: readonly AiTab[] = [
  {
    key: 'providers',
    segment: 'providers',
    icon: Server,
    roles: ['admin', 'teamLeader', 'agent', 'viewer'],
    installAdminOnly: true,
  },
  {
    key: 'knowledge',
    segment: 'knowledge',
    icon: Database,
    roles: ['admin', 'teamLeader'],
    installAdminOnly: false,
  },
  {
    key: 'assistant',
    segment: 'assistant',
    icon: Bot,
    roles: ['admin', 'teamLeader'],
    installAdminOnly: false,
  },
];

export interface AiViewer {
  readonly role: StaffRole;
  readonly installAdmin: boolean;
}

export const aiTabsFor = (viewer: AiViewer): readonly AiTab[] =>
  AI_TABS.filter((tab) =>
    tab.installAdminOnly ? viewer.installAdmin : tab.roles.includes(viewer.role),
  );

export const aiTabForSegment = (segment: string | undefined, viewer: AiViewer): AiTab | undefined =>
  aiTabsFor(viewer).find((tab) => tab.segment === segment);
