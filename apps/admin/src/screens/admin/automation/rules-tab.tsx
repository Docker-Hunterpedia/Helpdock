import type { RuleKind, WorkflowRule, WorkflowRuleList, WorkflowRun } from '@helpdock/schemas';
import { Box, IconButton, ListItemIcon, Menu, MenuItem, Typography } from '@mui/material';
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  EllipsisVertical,
  GripVertical,
  Pencil,
  Trash2,
  Workflow,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ruleRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { automationKeys } from '../../../automation/api.js';
import { useAutomationApi } from '../../../automation/context.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { Switch } from '../../../ui/switch.tsx';
import { moveBy, moveTo } from '../ticketing/reorder.js';
import { useTicketingAction, useTicketingReport } from '../ticketing/use-ticketing-action.js';
import { ExecutionLog } from './execution-log.tsx';
import { useRuleText } from './rule-text.js';
import { useTimeOfDay } from './time.js';

/**
 * The Rules and Time-based tabs (`AdminAutomationRules`): one kind's rules in
 * the order they run, beside the brand's execution log.
 *
 * The order is the list's: dragging a handle, or ArrowUp / ArrowDown on it, or
 * "Move up" / "Move down" in a row's menu, sends the whole list back
 * (`POST …/rules/reorder`), which is the one shape the api accepts.
 *
 * When the depth guard has stopped a loop in the last day, a warning names
 * the rules in it and the row of the rule that was stopped is tinted, so the
 * person who can fix it sees where.
 */

const GRID = '20px 20px minmax(0, 1fr) 112px 80px 64px 44px 28px';
const DAY_MS = 24 * 60 * 60 * 1000;

export function RulesTab({
  kind,
  rules,
}: {
  readonly kind: RuleKind;
  readonly rules: UseQueryResult<WorkflowRuleList>;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const brand = currentBrand(useSession());
  const api = useAutomationApi();
  const queryClient = useQueryClient();
  const report = useTicketingReport();
  const options = useQuery({
    queryKey: automationKeys.options(brand.id),
    queryFn: () => api.options(brand.id),
  });
  const stopped = useQuery({
    queryKey: automationKeys.runs(brand.id, { result: 'stopped' }),
    queryFn: () => api.runs(brand.id, { result: 'stopped' }),
  });
  const text = useRuleText(options.data);
  const timeOf = useTimeOfDay();

  const [menuFor, setMenuFor] = useState<{ rule: WorkflowRule; anchor: HTMLElement } | null>(null);
  const [confirming, setConfirming] = useState<WorkflowRule | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const rows = (rules.data?.rules ?? [])
    .filter((rule) => rule.kind === kind)
    .sort((a, b) => a.position - b.position);
  const order = rows.map((rule) => rule.id);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: automationKeys.all(brand.id) });
  };

  const toggle = useTicketingAction(
    (rule: WorkflowRule) => api.setRuleEnabled(brand.id, rule.id, !rule.enabled),
    (rule) => t(rule.enabled ? 'rules:toast.disabled' : 'rules:toast.enabled', { name: rule.name }),
    refresh,
    report,
  );
  const reorder = useTicketingAction(
    (next: readonly string[]) => api.reorderRules(brand.id, kind, next),
    () => t('rules:toast.reordered'),
    refresh,
    report,
  );
  const remove = useTicketingAction(
    (rule: WorkflowRule) => api.deleteRule(brand.id, rule.id),
    (rule) => t('rules:toast.deleted', { name: rule.name }),
    refresh,
    report,
  );
  const busy = toggle.isPending || reorder.isPending || remove.isPending;

  const applyOrder = (next: readonly string[]): void => {
    if (next !== order) {
      reorder.mutate(next);
    }
  };

  const loop = latestLoop(stopped.data?.runs ?? [], rows);
  const menuRule = menuFor?.rule ?? null;
  const heading = kind === 'event' ? 'rules' : 'timeBased';

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 420px' },
        gap: 6,
        alignItems: 'start',
      }}
    >
      <Box
        component="section"
        aria-labelledby="rules-heading"
        sx={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}
      >
        <Box>
          <Typography variant="h3" component="h2" id="rules-heading">
            {t(`rules:list.${heading}.heading`)}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t(`rules:list.${heading}.body`)}
          </Typography>
        </Box>

        {loop === null ? null : (
          <AlertBanner tone="warning">
            <strong>{loop.names.join(t('rules:text.andSeparator'))}</strong>{' '}
            {t('rules:list.loop', { ticket: loop.ticket })}
          </AlertBanner>
        )}

        {rules.data === undefined ? null : rows.length === 0 ? (
          <EmptyState
            icon={Workflow}
            heading={t(`rules:list.${heading}.emptyHeading`)}
            body={t(`rules:list.${heading}.emptyBody`)}
          />
        ) : (
          <Box
            sx={{
              borderRadius: '10px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.surface'],
              overflowX: 'auto',
            }}
          >
            <Box
              aria-hidden="true"
              sx={{
                display: 'grid',
                gridTemplateColumns: GRID,
                gap: 2,
                alignItems: 'center',
                height: 40,
                paddingInline: 3,
                minWidth: 640,
                backgroundColor: tokens['bg.muted'],
                color: 'text.secondary',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              <span />
              <span>{t('rules:list.columns.position')}</span>
              <span>{t('rules:list.columns.rule')}</span>
              <span>
                {t(kind === 'event' ? 'rules:list.columns.when' : 'rules:list.columns.every')}
              </span>
              <span style={{ textAlign: 'end' }}>{t('rules:list.columns.lastRun')}</span>
              <span style={{ textAlign: 'end' }}>{t('rules:list.columns.runs')}</span>
              <span>{t('rules:list.columns.on')}</span>
              <span />
            </Box>
            <Box
              component="ol"
              aria-label={t(`rules:list.${heading}.caption`)}
              sx={{ margin: 0, padding: 0, listStyle: 'none', minWidth: 640 }}
            >
              {rows.map((rule) => (
                <Box
                  component="li"
                  key={rule.id}
                  onDragOver={(event) => {
                    event.preventDefault();
                  }}
                  onDrop={() => {
                    if (dragging !== null && dragging !== rule.id) {
                      applyOrder(moveTo(order, dragging, order.indexOf(rule.id)));
                    }
                    setDragging(null);
                  }}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: GRID,
                    gap: 2,
                    alignItems: 'center',
                    minHeight: 60,
                    paddingBlock: 2,
                    paddingInline: 3,
                    borderBlockStart: `1px solid ${tokens['bg.muted']}`,
                    backgroundColor:
                      loop?.ruleId === rule.id ? tokens['status.warning.tint'] : undefined,
                  }}
                >
                  <IconButton
                    size="small"
                    aria-label={t('rules:list.reorder', { name: rule.name })}
                    draggable
                    disabled={busy}
                    onDragStart={() => {
                      setDragging(rule.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        applyOrder(moveBy(order, rule.id, event.key === 'ArrowUp' ? -1 : 1));
                      }
                    }}
                    sx={{ width: 20, height: 28, cursor: 'grab', color: 'text.secondary' }}
                  >
                    <GripVertical size={16} aria-hidden="true" />
                  </IconButton>
                  <Typography variant="mono" component="span" sx={{ color: 'text.secondary' }}>
                    {rule.position}
                  </Typography>
                  <Box
                    component={Link}
                    to={ruleRoute(rule.id)}
                    sx={{
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px',
                      color: 'text.primary',
                      textDecoration: 'none',
                      '&:hover span:first-of-type': { textDecoration: 'underline' },
                    }}
                  >
                    <Typography component="span" sx={{ fontWeight: 500 }}>
                      {rule.name}
                    </Typography>
                    <Typography
                      component="span"
                      variant="caption"
                      sx={{
                        color: 'text.secondary',
                        fontWeight: 400,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {text.summary(rule)}
                    </Typography>
                  </Box>
                  <Typography component="span" variant="body2">
                    {rule.kind === 'event'
                      ? text.trigger(rule.trigger ?? 'ticket_created')
                      : t(`rules:intervals.${String(rule.intervalMinutes ?? 15) as '15'}`)}
                  </Typography>
                  <Typography
                    variant="mono"
                    component="span"
                    sx={{ textAlign: 'end', color: 'text.secondary' }}
                  >
                    {rule.lastAppliedAt === null
                      ? t('rules:list.never')
                      : timeOf(rule.lastAppliedAt)}
                  </Typography>
                  <Typography variant="mono" component="span" sx={{ textAlign: 'end' }}>
                    {rule.appliedLast30Days}
                  </Typography>
                  <Switch
                    checked={rule.enabled}
                    label={t('rules:list.enable', { name: rule.name })}
                    disabled={busy}
                    onChange={() => {
                      toggle.mutate(rule);
                    }}
                  />
                  <IconButton
                    size="small"
                    aria-label={t('rules:list.actions', { name: rule.name })}
                    aria-haspopup="menu"
                    disabled={busy}
                    onClick={(event) => {
                      setMenuFor({ rule, anchor: event.currentTarget });
                    }}
                    sx={{ width: 28, height: 28 }}
                  >
                    <EllipsisVertical size={16} aria-hidden="true" />
                  </IconButton>
                </Box>
              ))}
            </Box>
          </Box>
        )}

        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t(kind === 'event' ? 'rules:list.footnote' : 'rules:list.timeBased.footnote')}
        </Typography>
      </Box>

      <ExecutionLog options={options.data} />

      <Menu
        anchorEl={menuFor?.anchor ?? null}
        open={menuFor !== null}
        onClose={() => {
          setMenuFor(null);
        }}
        slotProps={{
          list: { 'aria-label': t('rules:list.actions', { name: menuRule?.name ?? '' }) },
        }}
      >
        <MenuItem component={Link} to={ruleRoute(menuRule?.id ?? '')}>
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('rules:list.menu.edit')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuRule !== null) {
              applyOrder(moveBy(order, menuRule.id, -1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowUp size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('rules:list.menu.moveUp')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuRule !== null) {
              applyOrder(moveBy(order, menuRule.id, 1));
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <ArrowDown size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('rules:list.menu.moveDown')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setConfirming(menuRule);
            setMenuFor(null);
          }}
          sx={{ color: tokens['status.danger.text'] }}
        >
          <ListItemIcon sx={{ color: 'inherit' }}>
            <Trash2 size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('rules:list.menu.delete')}
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirming !== null}
        destructive
        busy={busy}
        title={t('rules:list.confirm.title', { name: confirming?.name ?? '' })}
        body={t('rules:list.confirm.body')}
        confirmLabel={t('rules:list.confirm.submit')}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming !== null) {
            remove.mutate(confirming);
          }
          setConfirming(null);
        }}
      />
    </Box>
  );
}

/**
 * The loop the depth guard stopped most recently in the last day, among this
 * list's rules: the names in its chain and the rule it stopped.
 */
export const latestLoop = (
  runs: readonly WorkflowRun[],
  rules: readonly WorkflowRule[],
  now: number = Date.now(),
): { ruleId: string; names: string[]; ticket: string } | null => {
  const listed = new Set(rules.map((rule) => rule.id));
  const run = runs.find(
    (candidate) =>
      candidate.result === 'stopped' &&
      listed.has(candidate.ruleId) &&
      now - Date.parse(candidate.createdAt) < DAY_MS,
  );
  if (run === undefined) {
    return null;
  }
  const names = [...new Set([...run.chain.map((link) => link.ruleName), run.ruleName])];
  return { ruleId: run.ruleId, names, ticket: run.ticketReference };
};
