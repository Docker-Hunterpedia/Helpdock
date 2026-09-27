import {
  type RuleBuilderOptions,
  type RuleRunQuery,
  type RuleRunResult,
  ruleRunResultSchema,
  type WorkflowRun,
} from '@helpdock/schemas';
import { Box, InputAdornment, Link as MuiLink, TextField, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { Ban, Search } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ruleRoute, ticketRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { automationKeys } from '../../../automation/api.js';
import { useAutomationApi } from '../../../automation/context.tsx';
import { useDebounced } from '../../../ui/use-debounced.js';
import { Choice } from './choice.tsx';
import { type RuleText, useRuleText } from './rule-text.js';
import { useTimeOfDay } from './time.js';

/**
 * The execution log beside the rule list (M3-03, `AdminAutomationRules`): every
 * run, newest first, filtered by result and by a rule's name or a ticket
 * reference. A run the depth guard stopped opens out into the chain that led
 * to it, which is the one entry a person has to act on.
 *
 * The api returns only the runs on tickets the reader can see (the log is
 * department-scoped), so a Team Leader's log is their departments'.
 */

const RESULT_TONE = {
  applied: 'success',
  skipped: null,
  stopped: 'warning',
  failed: 'danger',
} as const satisfies Record<RuleRunResult, 'success' | 'warning' | 'danger' | null>;

export function ExecutionLog({
  options,
}: {
  readonly options: RuleBuilderOptions | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const brand = currentBrand(useSession());
  const api = useAutomationApi();
  const text = useRuleText(options);
  const timeOf = useTimeOfDay();
  const [result, setResult] = useState<RuleRunResult | ''>('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);

  const query: RuleRunQuery = {
    ...(result === '' ? {} : { result }),
    ...(q === '' ? {} : { q }),
  };
  const runs = useQuery({
    queryKey: automationKeys.runs(brand.id, query),
    queryFn: () => api.runs(brand.id, query),
  });

  return (
    <Box
      component="aside"
      aria-labelledby="log-heading"
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        minWidth: 0,
      }}
    >
      <Box
        sx={{
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
          <Typography variant="h3" component="h2" id="log-heading">
            {t('rules:log.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('rules:log.newestFirst')}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Choice
            value={result}
            onChange={(value) => {
              const parsed = ruleRunResultSchema.safeParse(value);
              setResult(parsed.success ? parsed.data : '');
            }}
            label={t('rules:log.result')}
            sx={{ minWidth: 150 }}
          >
            <option value="">{t('rules:log.results.all')}</option>
            {ruleRunResultSchema.options.map((option) => (
              <option key={option} value={option}>
                {t(`rules:log.results.${option}`)}
              </option>
            ))}
          </Choice>
          <TextField
            type="search"
            size="small"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder={t('rules:log.searchPlaceholder')}
            slotProps={{
              htmlInput: { 'aria-label': t('rules:log.search') },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search size={16} aria-hidden="true" />
                  </InputAdornment>
                ),
              },
            }}
            sx={{ flex: 1 }}
          />
        </Box>
      </Box>

      {runs.data?.runs.length === 0 ? (
        <Typography variant="body2" sx={{ padding: 4, color: 'text.secondary' }}>
          {t('rules:log.empty')}
        </Typography>
      ) : (
        <Box
          component="ol"
          aria-label={t('rules:log.listLabel')}
          sx={{ margin: 0, padding: 0, listStyle: 'none' }}
        >
          {(runs.data?.runs ?? []).map((run) => (
            <RunEntry key={run.id} run={run} text={text} time={timeOf(run.createdAt)} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function RunEntry({
  run,
  text,
  time,
}: {
  readonly run: WorkflowRun;
  readonly text: RuleText;
  readonly time: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const tone = RESULT_TONE[run.result];

  return (
    <Box
      component="li"
      sx={{
        paddingBlock: 3,
        paddingInline: 4,
        borderBlockStart: `1px solid ${tokens['bg.muted']}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography variant="mono" component="span" sx={{ color: 'text.secondary' }}>
          {time}
        </Typography>
        <Typography component="span" sx={{ fontWeight: 500, flex: 1, minWidth: 0 }}>
          {run.ruleName}
        </Typography>
        <Box
          component="span"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 1,
            height: 22,
            paddingInline: 2,
            borderRadius: '999px',
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            backgroundColor: tone === null ? tokens['bg.muted'] : tokens[`status.${tone}.tint`],
            color: tone === null ? tokens['text.secondary'] : tokens[`status.${tone}.text`],
          }}
        >
          <Box
            component="span"
            aria-hidden="true"
            sx={{
              width: 6,
              height: 6,
              borderRadius: '999px',
              backgroundColor: tone === null ? tokens['text.disabled'] : tokens[`status.${tone}`],
            }}
          />
          {t(`rules:log.results.${run.result}`)}
        </Box>
      </Box>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        <MuiLink component={Link} to={ticketRoute(run.ticketId)}>
          <bdi>{run.ticketReference}</bdi>
        </MuiLink>
        {' · '}
        {detailOf(run, text, t)}
      </Typography>
      {run.result === 'stopped' ? <StoppedChain run={run} /> : null}
    </Box>
  );
}

const detailOf = (run: WorkflowRun, text: RuleText, t: ReturnType<typeof useT>): string => {
  switch (run.result) {
    case 'applied': {
      const changed = run.actions.filter((outcome) => outcome.effect === 'changed');
      const done =
        changed.length === 0
          ? t('rules:log.nothingChanged')
          : changed
              .map((outcome) => text.action(outcome.action))
              .join(t('rules:text.listSeparator'));
      return run.depth > 1 ? t('rules:log.atDepth', { detail: done, depth: run.depth }) : done;
    }
    case 'skipped': {
      const failed = run.failedGroup?.conditions.find((trace) => trace.outcome === 'failed');
      if (failed === undefined) {
        return t('rules:log.skipped');
      }
      return failed.actual === null
        ? t('rules:log.notMatched', { condition: text.condition(failed.condition) })
        : t('rules:log.notMatchedFound', {
            condition: text.condition(failed.condition),
            actual: text.actual(failed),
          });
    }
    case 'stopped':
      return t(run.stopReason === 'cycle' ? 'rules:log.cycle' : 'rules:log.tooDeep');
    case 'failed':
      return t('rules:log.failed');
  }
};

/** The chain behind a stopped run, as the artboard opens it out. */
function StoppedChain({ run }: { readonly run: WorkflowRun }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        marginBlockStart: 1,
        padding: 3,
        borderRadius: '6px',
        border: `1px solid ${tokens['status.warning']}`,
        backgroundColor: tokens['status.warning.tint'],
        color: tokens['status.warning.text'],
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600, color: 'inherit' }}>
        {t(
          run.stopReason === 'cycle' ? 'rules:log.chain.cycleTitle' : 'rules:log.chain.depthTitle',
          {
            depth: run.depth,
          },
        )}
      </Typography>
      <Box
        component="ol"
        sx={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 1 }}
      >
        {run.chain.map((link, index) => (
          <Box
            component="li"
            key={`${link.ruleId}-${String(index)}`}
            sx={{ display: 'flex', gap: 2, alignItems: 'baseline' }}
          >
            <Typography variant="mono" component="span" sx={{ color: 'inherit' }}>
              {index + 1}
            </Typography>
            <Typography variant="body2" component="span" sx={{ color: 'inherit' }}>
              {t('rules:log.chain.ran', { rule: link.ruleName })}
            </Typography>
          </Box>
        ))}
        <Box component="li" sx={{ display: 'flex', gap: 2, alignItems: 'baseline' }}>
          <Ban size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
          <Typography variant="body2" component="span" sx={{ color: 'inherit' }}>
            {t(run.stopReason === 'cycle' ? 'rules:log.chain.again' : 'rules:log.chain.fourth', {
              rule: run.ruleName,
            })}
          </Typography>
        </Box>
      </Box>
      <Typography variant="caption" sx={{ color: 'inherit' }}>
        {t('rules:log.chain.kept')}
      </Typography>
      <Box sx={{ display: 'flex', gap: 4 }}>
        <MuiLink component={Link} to={ticketRoute(run.ticketId)} variant="body2">
          {t('rules:log.chain.openTicket', { ticket: run.ticketReference })}
        </MuiLink>
        <MuiLink component={Link} to={ruleRoute(run.ruleId)} variant="body2">
          {t('rules:log.chain.editRule', { rule: run.ruleName })}
        </MuiLink>
      </Box>
    </Box>
  );
}
