import type { RuleKind } from '@helpdock/schemas';
import { Box, Button, Tab, Tabs } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { automationRoute, ruleRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { automationKeys } from '../../../automation/api.js';
import { useAutomationApi } from '../../../automation/context.tsx';
import { PageHeader } from '../../../shell/page-header.tsx';
import { MacrosTab } from './macros-tab.tsx';
import { RuleBuilder } from './rule-builder.tsx';
import { RulesTab } from './rules-tab.tsx';
import { tabForSegment, tabOfKind, tabsFor } from './tabs.js';

/**
 * `Admin/Automation` (M3-03 to M3-06; artboards `AdminAutomationRules`,
 * `AdminRuleBuilder` and `AdminAutomationMacros`): the page header, the tab
 * row, and either a tab's list or the builder for one rule.
 *
 * The builder sits under the tab its rule belongs to — an event rule under
 * Rules, a scheduled one under Time-based — so the tab row still says where
 * the person is, and "back" is the tab's own list.
 *
 * The row is the reader's: an Agent has Macros alone, and never asks for the
 * rules, which the api would refuse them.
 */
export function AutomationPage(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const brand = currentBrand(session);
  const api = useAutomationApi();
  const { tab: segment, ruleId } = useParams();
  const [search] = useSearchParams();
  const { pathname } = useLocation();

  const tabs = tabsFor(session.user.role);
  const readsRules = tabs.some((candidate) => candidate.kind !== null);

  const rules = useQuery({
    queryKey: automationKeys.rules(brand.id),
    queryFn: () => api.rules(brand.id),
    enabled: readsRules,
  });

  const editing = ruleId === undefined || !readsRules ? null : ruleId;
  const newKind: RuleKind = search.get('kind') === 'scheduled' ? 'scheduled' : 'event';
  const editedRule =
    editing === null || editing === 'new'
      ? undefined
      : rules.data?.rules.find((rule) => rule.id === editing);

  const tab =
    editing === null
      ? tabForSegment(tabs, segment)
      : tabOfKind(editing === 'new' ? newKind : (editedRule?.kind ?? 'event'));

  if (tab === undefined) {
    const first = tabs[0];
    return first === undefined ? null : <Navigate to={automationRoute(first.segment)} replace />;
  }

  const newRuleKind: RuleKind = tab.kind ?? 'event';

  return (
    <>
      <PageHeader
        title={t('rules:title')}
        caption={t('rules:subtitle', { brand: brand.name })}
        action={
          tab.kind === null ? undefined : (
            <Button
              variant="contained"
              component={Link}
              to={`${ruleRoute('new')}?kind=${newRuleKind}`}
              startIcon={<Plus size={16} aria-hidden="true" />}
              disabled={pathname === ruleRoute('new')}
            >
              {t('rules:newRule')}
            </Button>
          )
        }
      />

      <Box sx={{ borderBlockEnd: `1px solid ${tokens['border.default']}`, marginBlockEnd: 6 }}>
        <Tabs value={tab.key} aria-label={t('rules:tabList')}>
          {tabs.map((candidate) => (
            <Tab
              key={candidate.key}
              value={candidate.key}
              label={t(`rules:tabs.${candidate.key}`)}
              component={Link}
              to={automationRoute(candidate.segment)}
            />
          ))}
        </Tabs>
      </Box>

      {editing !== null ? (
        <RuleBuilder
          key={editing}
          ruleId={editing === 'new' ? null : editing}
          rule={editedRule}
          loading={rules.isPending}
          newKind={newKind}
          position={
            editedRule?.position ??
            (rules.data?.rules.filter((rule) => rule.kind === newKind).length ?? 0) + 1
          }
        />
      ) : tab.kind === null ? (
        <MacrosTab />
      ) : (
        <RulesTab kind={tab.kind} rules={rules} />
      )}
    </>
  );
}
