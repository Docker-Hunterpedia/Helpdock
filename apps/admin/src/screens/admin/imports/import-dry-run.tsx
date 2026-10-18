import type {
  ImportRunView,
  ImportStartRequest,
  importContactPreviewSchema,
  importDryRunReportSchema,
  importTicketPreviewSchema,
} from '@helpdock/schemas';
import { Box, Button, Checkbox, FormControlLabel, Skeleton, Typography } from '@mui/material';
import { Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { SectionCard } from '../channels/section-card.tsx';
import { ImportContactSample } from './import-contact-sample.js';
import { ImportIssues } from './import-issues.js';
import { ImportTicketSample } from './import-ticket-sample.js';

type Report = z.infer<typeof importDryRunReportSchema>;
type TicketPreview = z.infer<typeof importTicketPreviewSchema>;
const SUMMARY_ENTITIES = [
  'ticket',
  'message',
  'contact',
  'organization',
  'article',
  'attachment',
] as const;

/** Admin/Import-Wizard, dry-run artboard: an explicit receipt is required before loading. */
export function ImportDryRun({
  run,
  report,
  previews,
  contacts,
  busy,
  failed,
  previewError = false,
  startDisabled = false,
  onStart,
  onRevalidate,
  onReviewIssue,
}: {
  run: ImportRunView;
  report: Report | undefined;
  previews: TicketPreview[] | undefined;
  contacts: z.infer<typeof importContactPreviewSchema>[] | undefined;
  busy: boolean;
  failed: boolean;
  previewError?: boolean;
  startDisabled?: boolean;
  onStart: (request: ImportStartRequest) => void;
  onRevalidate: () => void;
  onReviewIssue?: (issue: Report['issues'][number]) => void;
}) {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const [accepted, setAccepted] = useState<{ token: string | null; value: boolean }>({
    token: null,
    value: false,
  });
  const acknowledged = accepted.token === report?.reviewToken && accepted.value;
  const canStart =
    report?.complete === true &&
    report.reviewToken !== null &&
    report.errors === 0 &&
    (report.warnings === 0 || acknowledged) &&
    !busy &&
    !startDisabled &&
    !failed &&
    !previewError &&
    previews !== undefined &&
    contacts !== undefined &&
    ['awaiting_mapping', 'ready'].includes(run.status);
  const totalIssues = (report?.errors ?? 0) + (report?.warnings ?? 0);
  const issues = report?.issues.slice(0, 20) ?? [];
  return (
    <SectionCard
      id="import-dry-run"
      heading={t('imports:dryRun.title')}
      caption={t('imports:dryRun.caption')}
      footer={
        <>
          <Button
            variant="outlined"
            disabled={busy || !['awaiting_mapping', 'ready'].includes(run.status)}
            startIcon={<RotateCcw size={16} aria-hidden="true" />}
            onClick={onRevalidate}
          >
            {t('imports:dryRun.rerun')}
          </Button>
          <Button
            variant="contained"
            disabled={!canStart}
            startIcon={<Play size={16} aria-hidden="true" />}
            onClick={() => {
              if (canStart && report?.reviewToken)
                onStart({ reviewToken: report.reviewToken, acknowledgeWarnings: acknowledged });
            }}
          >
            {t('imports:dryRun.start')}
          </Button>
        </>
      }
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: 'repeat(2, minmax(0, 1fr))',
            md: 'repeat(3, minmax(0, 1fr))',
            xl: 'repeat(6, minmax(0, 1fr))',
          },
          gap: 3,
        }}
      >
        {SUMMARY_ENTITIES.map((entity) => (
          <Box
            key={entity}
            sx={{
              padding: 3,
              border: `1px solid ${tokens['border.default']}`,
              borderRadius: '6px',
            }}
          >
            <Typography variant="h2" component="p">
              <bdi dir="ltr">
                {new Intl.NumberFormat(locale, { numberingSystem: 'latn' }).format(
                  run.counts.extracted[entity] ?? 0,
                )}
              </bdi>
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t(`imports:entities.${entity}`)}
            </Typography>
          </Box>
        ))}
      </Box>
      {failed ? <AlertBanner tone="danger">{t('imports:dryRun.failed')}</AlertBanner> : null}
      {!report && !failed ? (
        <Box role="status" aria-label={t('imports:dryRun.checking')}>
          <Skeleton />
          <Skeleton />
        </Box>
      ) : null}
      {report ? (
        <>
          {!report.complete ? (
            <AlertBanner tone="info">
              {t(
                report.phase === 'invalidated' ? 'imports:dryRun.stale' : 'imports:dryRun.checking',
              )}
            </AlertBanner>
          ) : null}
          {report.errors > 0 ? (
            <AlertBanner tone="danger">
              {t('imports:dryRun.errors', { count: report.errors })}
            </AlertBanner>
          ) : null}
          {report.warnings > 0 ? (
            <AlertBanner tone="warning">
              {t('imports:dryRun.warnings', { count: report.warnings })}
            </AlertBanner>
          ) : null}
          {report.complete && totalIssues === 0 ? (
            <AlertBanner tone="success">{t('imports:dryRun.clear')}</AlertBanner>
          ) : null}
          <ImportIssues issues={issues} busy={busy} onReview={onReviewIssue} />
          {totalIssues > issues.length ? (
            <Typography variant="caption" color="text.secondary">
              {t('imports:dryRun.shown', { shown: issues.length, count: totalIssues })}
            </Typography>
          ) : null}
          {report.warnings > 0 ? (
            <FormControlLabel
              control={
                <Checkbox
                  checked={acknowledged}
                  disabled={busy || !report.complete}
                  onChange={(_, value) => setAccepted({ token: report.reviewToken, value })}
                />
              }
              label={t('imports:dryRun.acknowledge')}
            />
          ) : null}
        </>
      ) : null}
      <Typography component="h3" variant="h3">
        {t('imports:dryRun.preview')}
      </Typography>
      {previewError ? (
        <AlertBanner tone="danger">{t('imports:dryRun.previewFailed')}</AlertBanner>
      ) : previews === undefined ? (
        <Skeleton />
      ) : previews.length ? (
        previews.map((preview) => (
          <ImportTicketSample
            key={`${report?.reviewToken ?? 'pending'}:${preview.ticket.externalId}`}
            brandId={run.brandId}
            runId={run.id}
            revision={report?.reviewToken ?? 'pending'}
            preview={preview}
            source={t(`imports:sources.${run.source}`)}
          />
        ))
      ) : (
        <Typography color="text.secondary">{t('imports:dryRun.emptyPreview')}</Typography>
      )}
      <Typography component="h3" variant="h3">
        {t('imports:dryRun.contactPreview')}
      </Typography>
      {contacts?.map((preview) => (
        <ImportContactSample key={preview.source.externalId} preview={preview} />
      ))}
      {contacts?.length === 0 ? (
        <Typography color="text.secondary">{t('imports:dryRun.emptyContacts')}</Typography>
      ) : null}
    </SectionCard>
  );
}
