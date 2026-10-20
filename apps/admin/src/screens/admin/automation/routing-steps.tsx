import type {
  RoutingDepartmentRef,
  RoutingEntryPoint,
  RoutingOverview,
  RoutingOverviewRule,
} from '@helpdock/schemas';
import { Box, Link as MuiLink, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import {
  aiRoute,
  automationRoute,
  channelsRoute,
  mailboxRoute,
  metaAccountRoute,
  telegramBotRoute,
  ticketingRoute,
} from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import type { RuleText } from './rule-text.js';

/**
 * DESIGN §6.3 RoutingSteps (M14-09, `Admin/Automation-Routing`): the pipeline
 * a new ticket goes through, as four numbered steps, each with a link to the
 * place it is edited and a bordered list of what it holds today.
 */

type Translate = ReturnType<typeof useT>;

export const departmentName = (department: RoutingDepartmentRef, locale: 'en' | 'ar'): string =>
  locale === 'ar' && department.nameAr ? department.nameAr : department.name;

/** The door as the steps and the test's select name it. */
export const doorName = (
  t: Translate,
  door: Pick<RoutingEntryPoint, 'entry' | 'label' | 'platform' | 'enabled'>,
): string => {
  const label = door.label ?? '';
  switch (door.entry) {
    case 'meta_account':
      return t('rules:routing.entry.meta_account', {
        label,
        channel: t(`rules:channels.${door.platform ?? 'whatsapp'}`),
      });
    case 'web_form':
      return t(door.enabled ? 'rules:routing.entry.web_form' : 'rules:routing.entry.web_formOff');
    default:
      return t(`rules:routing.entry.${door.entry}`, { label });
  }
};

/** Where a door is edited. */
const doorRoute = (door: RoutingEntryPoint): string => {
  switch (door.entry) {
    case 'mailbox':
      return door.entryId === null ? channelsRoute('mailboxes') : mailboxRoute(door.entryId);
    case 'telegram_bot':
      return door.entryId === null ? channelsRoute('telegram') : telegramBotRoute(door.entryId);
    case 'meta_account':
      return door.entryId === null ? channelsRoute('meta') : metaAccountRoute(door.entryId);
    case 'web_form':
      return channelsRoute('web-form');
    default:
      return channelsRoute('widget');
  }
};

function Step({
  n,
  title,
  body,
  editTo,
  children,
}: {
  readonly n: number;
  readonly title: string;
  readonly body: string;
  readonly editTo: string;
  readonly children?: ReactNode;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box component="li" sx={{ display: 'flex', gap: 3 }}>
      <Box
        aria-hidden="true"
        sx={{
          width: 24,
          height: 24,
          borderRadius: '999px',
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens['text.primary'],
          color: tokens['bg.surface'],
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {n}
      </Box>
      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography component="h3" sx={{ fontWeight: 600, fontSize: 14 }}>
          {title}{' '}
          <MuiLink
            component={Link}
            to={editTo}
            aria-label={t('rules:routing.editStep', { step: title })}
            sx={{ fontWeight: 400, fontSize: 13 }}
          >
            {t('rules:routing.edit')}
          </MuiLink>
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {body}
        </Typography>
        {children}
      </Box>
    </Box>
  );
}

function Rows({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {children}
    </Box>
  );
}

function Row({
  name,
  detail,
}: {
  readonly name: ReactNode;
  readonly detail?: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 3,
        paddingBlock: '6px',
        borderBlockStart: `1px solid ${tokens['border.default']}`,
        fontSize: 13,
      }}
    >
      <Box component="bdi">{name}</Box>
      {detail === undefined ? null : (
        <Box component="span" sx={{ color: 'text.secondary', textAlign: 'end' }}>
          {detail}
        </Box>
      )}
    </Box>
  );
}

const departmentOf = (t: Translate, door: RoutingEntryPoint, locale: 'en' | 'ar'): string => {
  if (door.department === null) {
    return t('rules:routing.department.namedByApi');
  }
  const name = departmentName(door.department, locale);
  return door.reason === 'brand_first_department'
    ? t('rules:routing.department.firstOfBrand', { name })
    : t('rules:routing.department.own', { name });
};

function ruleSummary(rule: RoutingOverviewRule, text: RuleText): string {
  return rule.actions.map(text.action).join(', ');
}

export function RoutingSteps({
  overview,
  text,
}: {
  readonly overview: RoutingOverview;
  readonly text: RuleText;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const enabled = overview.rules.filter((rule) => rule.enabled);

  return (
    <Box
      component="section"
      aria-labelledby="routing-heading"
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        minWidth: 0,
      }}
    >
      <Box sx={{ padding: 4, borderBlockEnd: `1px solid ${tokens['border.default']}` }}>
        <Typography variant="h3" component="h2" id="routing-heading">
          {t('rules:routing.heading')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t('rules:routing.subtitle')}
        </Typography>
      </Box>

      <Box
        component="ol"
        sx={{ listStyle: 'none', margin: 0, padding: 4, display: 'grid', gap: 5 }}
      >
        <Step
          n={1}
          title={t('rules:routing.steps.arrival.title')}
          body={t('rules:routing.steps.arrival.body')}
          editTo={channelsRoute('mailboxes')}
        >
          <Rows>
            {overview.entryPoints.map((door) => (
              <Row
                key={`${door.entry}:${door.entryId ?? ''}`}
                name={
                  <MuiLink component={Link} to={doorRoute(door)}>
                    {doorName(t, door)}
                  </MuiLink>
                }
                detail={departmentOf(t, door, locale)}
              />
            ))}
          </Rows>
        </Step>

        <Step
          n={2}
          title={t('rules:routing.steps.rules.title')}
          body={
            enabled.length === 0
              ? t('rules:routing.steps.rules.none')
              : t('rules:routing.steps.rules.body', { count: enabled.length })
          }
          editTo={automationRoute('rules')}
        >
          <Rows>
            {overview.rules.map((rule) => (
              <Row
                key={rule.id}
                name={rule.name}
                detail={rule.enabled ? ruleSummary(rule, text) : t('rules:routing.steps.rules.off')}
              />
            ))}
          </Rows>
        </Step>

        <Step
          n={3}
          title={t('rules:routing.steps.triage.title')}
          body={t('rules:routing.steps.triage.body')}
          editTo={aiRoute('assistant')}
        >
          <Rows>
            {overview.triageRules.length === 0 ? (
              <Row name={t('rules:routing.steps.triage.none')} />
            ) : (
              overview.triageRules.map((rule) => (
                <Row
                  key={rule.id}
                  name={t('rules:routing.steps.triage.queuedBy', { name: rule.name })}
                />
              ))
            )}
          </Rows>
        </Step>

        <Step
          n={4}
          title={t('rules:routing.steps.assignment.title')}
          body={t('rules:routing.steps.assignment.body')}
          editTo={ticketingRoute('assignment')}
        >
          <Rows>
            {overview.assignment.length === 0 ? (
              <Row name={t('rules:routing.steps.assignment.none')} />
            ) : (
              overview.assignment.map((entry) => (
                <Row
                  key={entry.department.id}
                  name={departmentName(entry.department, locale)}
                  detail={
                    entry.mode === 'manual'
                      ? t('rules:routing.assignment.manual')
                      : t(
                          entry.loadCap === null
                            ? 'rules:routing.assignment.row'
                            : 'rules:routing.assignment.rowCap',
                          {
                            mode: t(`ticketing:assignment.modes.${entry.mode}`),
                            people: t('rules:routing.assignment.people', {
                              count: entry.peopleInRotation,
                            }),
                            cap: entry.loadCap,
                          },
                        )
                  }
                />
              ))
            )}
          </Rows>
        </Step>
      </Box>
    </Box>
  );
}
