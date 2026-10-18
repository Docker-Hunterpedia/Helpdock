import type { importTicketPreviewSchema } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { formatClock, formatDay } from '../../../ui/format.js';

type Preview = z.infer<typeof importTicketPreviewSchema>;
export function ImportTicketSample({
  preview,
  source,
  brandId,
  runId,
  revision,
}: {
  preview: Preview;
  source: string;
  brandId: string;
  runId: string;
  revision: string;
}) {
  const t = useT();
  const tokens = useSemanticTokens();
  const api = useImportsApi();
  const [offsets, setOffsets] = useState([0]);
  const offset = offsets.at(-1) ?? 0;
  const history = useQuery({
    queryKey: [
      'imports',
      brandId,
      'run',
      runId,
      'history-preview',
      revision,
      preview.ticket.externalId,
      offset,
    ],
    queryFn: () =>
      api.ticketPreview(brandId, runId, {
        externalId: preview.ticket.externalId,
        offset,
        limit: 20,
      }),
    initialData: offset === 0 ? preview : undefined,
    enabled: offset !== 0,
  });
  const page = history.data;
  return (
    <Box
      component="article"
      sx={{
        padding: 4,
        border: `1px solid ${tokens['border.default']}`,
        borderRadius: '6px',
        display: 'grid',
        gap: 3,
      }}
    >
      <Typography component="h4" variant="body1" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
        {preview.ticket.subject}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t('imports:dryRun.source', { source })} ·{' '}
        <bdi dir="ltr">{`#${preview.ticket.number ?? preview.ticket.externalId}`}</bdi>
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t('imports:dryRun.history', { count: preview.messageCount })}
      </Typography>
      {history.isError ? (
        <AlertBanner tone="danger">
          {t('imports:dryRun.previewFailed')}{' '}
          <Button onClick={() => void history.refetch()}>{t('imports:retry')}</Button>
        </AlertBanner>
      ) : null}
      {history.isPending ? <Typography role="status">{t('imports:loading')}</Typography> : null}
      {page?.messages.map((message) => (
        <SampleMessage key={`${offset}:${message.externalId}`} message={message} />
      ))}
      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button
          disabled={offsets.length === 1 || history.isFetching}
          onClick={() => setOffsets((previous) => previous.slice(0, -1))}
        >
          {t('imports:dryRun.previousMessages')}
        </Button>
        <Button
          disabled={!page || page.nextOffset === null || history.isFetching}
          onClick={() => {
            const next = page?.nextOffset;
            if (typeof next === 'number') setOffsets((previous) => [...previous, next]);
          }}
        >
          {t('imports:dryRun.nextMessages')}
        </Button>
      </Box>
    </Box>
  );
}

function SampleMessage({ message }: { message: Preview['messages'][number] }) {
  const t = useT();
  const { locale } = usePreferences();
  const [expanded, setExpanded] = useState(false);
  return (
    <Box sx={{ display: 'grid', gap: 2, paddingBlock: 3 }}>
      <Typography variant="caption" color="text.secondary">
        <bdi>
          {message.sourceAuthorName ??
            message.authorExternalId ??
            t(
              message.authorKind === 'system'
                ? 'imports:dryRun.systemAuthor'
                : 'imports:dryRun.unknownAuthor',
            )}
        </bdi>{' '}
        ·{' '}
        <bdi>
          <time dateTime={message.createdAt}>
            {formatDay(message.createdAt, locale)} · {formatClock(message.createdAt, locale)}
          </time>
        </bdi>
        {message.public ? null : ` · ${t('imports:dryRun.private')}`}
      </Typography>
      <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {expanded ? message.bodyText : message.bodyText.slice(0, 1000)}
      </Typography>
      {message.bodyText.length > 1000 ? (
        <Button size="small" onClick={() => setExpanded((previous) => !previous)}>
          {t(expanded ? 'imports:dryRun.collapseMessage' : 'imports:dryRun.expandMessage')}
        </Button>
      ) : null}
      {message.attachments.length ? (
        <Box component="ul" sx={{ margin: 0, paddingInlineStart: 4 }}>
          {message.attachments.map((attachment) => (
            <li key={attachment.externalId}>
              <Typography variant="caption">
                <bdi>{attachment.fileName}</bdi>
              </Typography>
              <Typography
                component="span"
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block' }}
              >
                {t(`imports:dryRun.fileStates.${attachment.availability?.state ?? 'not_checked'}`)}
              </Typography>
            </li>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
