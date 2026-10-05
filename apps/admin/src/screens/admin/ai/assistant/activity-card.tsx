import type { AiCallSummary } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { useInfiniteQuery } from '@tanstack/react-query';
import { type ReactNode, useId } from 'react';
import { Link as RouterLink } from 'react-router';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { ticketRoute } from '../../../../app/route-paths.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { SectionCard } from '../../channels/section-card.tsx';
import { timeOf, usd } from '../format.js';

/**
 * AI activity on `Admin/AI-Assistant`: the brand's recent `ai_calls`, newest
 * first, a page at a time — what each call was for, the model, tokens in and
 * out, its cost and the ticket. Bodies stay behind the ticket's AI log, which
 * reads the ticket under the reader's department scope first.
 */

const FEATURES: Readonly<Record<string, string>> = {
  'assist.suggest_reply': 'suggestReply',
  'assist.summarize': 'summarize',
  'assist.translate': 'translate',
  'assist.rewrite': 'rewrite',
  'assist.triage': 'triage',
  'assist.draft_article': 'draftArticle',
  autoreply: 'autoReply',
  transcribe: 'transcribe',
  'knowledge.embed': 'embed',
  'knowledge.reembed': 'embed',
};

export function ActivityCard({ brandId }: { readonly brandId: string }): ReactNode {
  const t = useT();
  const api = useAiApi();
  const id = useId();
  const calls = useInfiniteQuery({
    queryKey: aiKeys.calls(brandId),
    queryFn: ({ pageParam }) => api.calls(brandId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = calls.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <SectionCard
      id={`${id}-activity`}
      heading={t('aiSettings:activity.heading')}
      caption={t('aiSettings:activity.caption')}
    >
      {calls.isError ? (
        <AlertBanner tone="danger">{t('aiSettings:loadFailed')}</AlertBanner>
      ) : calls.data === undefined ? (
        <Box aria-busy="true" />
      ) : items.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:activity.empty')}
        </Typography>
      ) : (
        <Box
          component="ul"
          aria-label={t('aiSettings:activity.listLabel')}
          sx={{ listStyle: 'none', margin: -5, padding: 0 }}
        >
          {items.map((call) => (
            <CallRow key={call.id} call={call} />
          ))}
        </Box>
      )}
      {calls.hasNextPage ? (
        <Button
          variant="text"
          disabled={calls.isFetchingNextPage}
          onClick={() => {
            void calls.fetchNextPage();
          }}
          sx={{ alignSelf: 'flex-start', marginBlockStart: 5 }}
        >
          {t('aiSettings:activity.loadMore')}
        </Button>
      ) : null}
      <Typography
        variant="caption"
        sx={{ color: 'text.secondary', marginBlockStart: calls.hasNextPage ? 0 : 5 }}
      >
        {t('aiSettings:activity.footer')}
      </Typography>
    </SectionCard>
  );
}

function CallRow({ call }: { readonly call: AiCallSummary }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const known = FEATURES[call.feature];
  const feature =
    known === undefined ? call.feature : t(`aiSettings:activity.features.${known as 'autoReply'}`);

  return (
    <Box
      component="li"
      sx={{
        display: 'grid',
        gridTemplateColumns: '44px minmax(0, 1fr) auto',
        gap: 3,
        paddingInline: 5,
        paddingBlock: 3,
        borderBlockEnd: `1px solid ${tokens['bg.muted']}`,
      }}
    >
      <Typography variant="mono" component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
        {timeOf(call.createdAt, locale)}
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {feature}
          {call.status === 'ok' ? null : (
            <Box component="span" sx={{ color: tokens['status.danger.text'] }}>
              {' · '}
              {t(`aiSettings:activity.status.${call.status}`)}
            </Box>
          )}
        </Typography>
        <Typography
          variant="mono"
          component="span"
          dir="ltr"
          sx={{ fontSize: 12, color: 'text.secondary', textAlign: 'start' }}
        >
          {call.status === 'refused'
            ? t('aiSettings:activity.noModelCall')
            : `${call.model} · ${t('aiSettings:activity.tokens', { in: call.tokensIn.toLocaleString('en-US'), out: call.tokensOut.toLocaleString('en-US') })}`}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <Typography variant="mono" component="span" dir="ltr" sx={{ fontSize: 12 }}>
          {usd(call.costUsd, 4)}
        </Typography>
        {call.ticket === null ? null : (
          <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
            <RouterLink to={ticketRoute(call.ticket.id)}>{call.ticket.reference}</RouterLink>
          </Typography>
        )}
      </Box>
    </Box>
  );
}
