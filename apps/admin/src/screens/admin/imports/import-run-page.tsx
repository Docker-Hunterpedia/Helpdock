import {
  type ImportRunView,
  type ImportStartRequest,
  importRunParamSchema,
} from '@helpdock/schemas';
import { Box, Button, LinearProgress, Skeleton, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { importRunRoute, ROUTES } from '../../../app/route-paths.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { importKeys } from '../../../imports/api.js';
import { useImportsApi } from '../../../imports/context.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { Field } from '../../../ui/field.js';
import { SectionCard } from '../channels/section-card.tsx';
import { ImportConnection } from './import-connection.js';
import { ImportDryRun } from './import-dry-run.js';
import { ImportFiles } from './import-files.js';
import { ImportLog } from './import-log.js';
import { ImportMappings } from './import-mappings.js';
import { ImportScope } from './import-scope.js';
import { ImportSla } from './import-sla.js';
import { ImportStatus } from './import-status.js';
import { ImportWizardProgress } from './import-wizard-progress.js';

const ACTIVE = ['extracting', 'dry_run', 'loading', 'finishing'];
export function ImportRunPage({ runId }: { runId: string }) {
  const session = useSession();
  const t = useT();
  const brandId = currentBrand(session).id;
  if (session.user.role !== 'admin')
    return <AlertBanner tone="danger">{t('imports:notAllowed')}</AlertBanner>;
  if (!importRunParamSchema.safeParse({ brandId, runId }).success)
    return <AlertBanner tone="danger">{t('imports:run.notFound')}</AlertBanner>;
  return <ImportRunContent key={`${brandId}:${runId}`} brandId={brandId} runId={runId} />;
}

function ImportRunContent({ brandId, runId }: { brandId: string; runId: string }) {
  const t = useT();
  const api = useImportsApi();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [mappingDirty, setMappingDirty] = useState(false);
  const [filesBusy, setFilesBusy] = useState(false);
  const [filesReady, setFilesReady] = useState(false);
  const [inventoryRevision, setInventoryRevision] = useState('');
  const [zohoInventory, setZohoInventory] = useState<boolean | null>(null);
  const [callingCode, setCallingCode] = useState<string | null>(null);
  const callingCodeId = useId();
  const run = useQuery({
    queryKey: importKeys.run(brandId, runId),
    queryFn: () => api.run(brandId, runId),
    refetchInterval: (query) => (ACTIVE.includes(query.state.data?.status ?? '') ? 2000 : false),
  });
  const reviewing = ['awaiting_mapping', 'ready', 'dry_run'].includes(run.data?.status ?? '');
  const report = useQuery({
    queryKey: importKeys.report(brandId, runId),
    queryFn: () => api.report(brandId, runId),
    enabled: reviewing && run.data?.hasDryRun === true,
    retry: false,
    refetchInterval: (query) =>
      reviewing && query.state.data?.phase !== 'invalidated' && !query.state.data?.complete
        ? 2000
        : false,
  });
  const previews = useQuery({
    queryKey: [
      'imports',
      brandId,
      'run',
      runId,
      'samples',
      report.data?.reviewToken,
      report.data?.defaultCallingCode,
    ],
    enabled: reviewing,
    queryFn: async () => {
      const sample = await api.samples(brandId, runId);
      const [tickets, contacts] = await Promise.all([
        Promise.all(
          sample.tickets.map((externalId) =>
            api.ticketPreview(brandId, runId, { externalId, offset: 0, limit: 20 }),
          ),
        ),
        Promise.all(
          sample.contacts.map((externalId) =>
            api.contactPreview(brandId, runId, {
              externalId,
              defaultCallingCode: report.data?.defaultCallingCode ?? '',
            }),
          ),
        ),
      ]);
      return { tickets, contacts };
    },
  });
  const updateRun = (value: ImportRunView) => {
    cache.setQueryData(importKeys.run(brandId, runId), value);
    void cache.invalidateQueries({ queryKey: importKeys.runs(brandId) });
    void cache.invalidateQueries({ queryKey: importKeys.report(brandId, runId) });
    void cache.invalidateQueries({ queryKey: ['imports', brandId, 'run', runId, 'samples'] });
  };
  const dryRun = useMutation({
    mutationFn: () =>
      api.dryRun(brandId, runId, {
        defaultCallingCode: callingCode ?? report.data?.defaultCallingCode ?? '',
      }),
    onSuccess: updateRun,
  });
  const start = useMutation({
    mutationFn: (input: ImportStartRequest) => api.start(brandId, runId, input),
    onSuccess: updateRun,
  });
  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') => api.control(brandId, runId, action),
    onSuccess: (value) => {
      setConfirmCancel(false);
      updateRun(value);
    },
  });
  const delta = useMutation({
    mutationFn: () => {
      if (!run.data) throw new Error('import.run-not-found');
      return api.create(brandId, { source: run.data.source, mode: 'delta', parentRunId: runId });
    },
    onSuccess: (value) => {
      void cache.invalidateQueries({ queryKey: importKeys.runs(brandId) });
      navigate(importRunRoute(value.id));
    },
  });
  const busy =
    dryRun.isPending || start.isPending || control.isPending || delta.isPending || filesBusy;
  if (run.isError && !run.data)
    return (
      <AlertBanner tone="danger">
        {t('imports:loadFailed')}{' '}
        <Button onClick={() => void run.refetch()}>{t('imports:retry')}</Button>
      </AlertBanner>
    );
  if (!run.data)
    return (
      <Box role="status" aria-label={t('imports:loading')}>
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </Box>
    );
  const value = run.data;
  return (
    <Box sx={{ display: 'grid', gap: 5 }}>
      <Box component="nav" aria-label={t('imports:run.breadcrumb')}>
        <Button component={Link} to={ROUTES.imports}>
          {t('imports:title')}
        </Button>
        {' / '}
        <bdi>{t(`imports:sources.${value.source}`)}</bdi>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
        <Typography component="h2" variant="h2">
          {t('imports:run.title', { source: t(`imports:sources.${value.source}`) })}
        </Typography>
        <ImportStatus status={value.status} />
      </Box>
      {value.sourceAccount ? (
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {t('imports:connection.connected')} <bdi dir="ltr">{value.sourceAccount}</bdi>
        </Typography>
      ) : null}
      <ImportWizardProgress run={value} busy={busy || mappingDirty} />
      {dryRun.isError || start.isError || control.isError || delta.isError ? (
        <AlertBanner tone="danger">{t('imports:run.actionFailed')}</AlertBanner>
      ) : null}
      {value.status === 'draft' ||
      (value.status === 'connecting' && !value.hasCredentials && value.source !== 'file') ? (
        <ImportConnection run={value} onConnected={updateRun} />
      ) : null}
      {value.status === 'connecting' && (value.hasCredentials || value.source === 'file') ? (
        <>
          {['file', 'freshdesk'].includes(value.source) ||
          (value.source === 'zohodesk' && (zohoInventory ?? value.scope.useTicketInventory)) ? (
            <ImportFiles
              brandId={brandId}
              runId={runId}
              inventory={value.source !== 'file'}
              onInventoryRevision={setInventoryRevision}
              onBusy={setFilesBusy}
              onReady={setFilesReady}
            />
          ) : null}
          <ImportScope
            run={value}
            onExtracting={updateRun}
            disabled={busy || (value.source === 'file' && !filesReady)}
            inventoryReady={filesReady && !filesBusy}
            inventoryRevision={inventoryRevision}
            onInventorySelection={setZohoInventory}
          />
        </>
      ) : null}
      {ACTIVE.includes(value.status) ||
      value.status === 'paused' ||
      value.status === 'completed' ||
      value.status === 'failed' ? (
        <SectionCard
          id="import-progress"
          heading={t('imports:run.progress')}
          caption={t('imports:run.quiet')}
        >
          <ImportProgress run={value} />
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            {ACTIVE.includes(value.status) ? (
              <Button
                variant="outlined"
                disabled={busy}
                startIcon={<Pause size={16} aria-hidden="true" />}
                onClick={() => control.mutate('pause')}
              >
                {t('imports:run.pause')}
              </Button>
            ) : null}
            {value.status === 'paused' ? (
              <Button
                variant="contained"
                disabled={busy}
                startIcon={<Play size={16} aria-hidden="true" />}
                onClick={() => control.mutate('resume')}
              >
                {t('imports:run.resume')}
              </Button>
            ) : null}
            {ACTIVE.includes(value.status) || value.status === 'paused' ? (
              <Button
                color="error"
                variant="outlined"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
              >
                {t('imports:run.cancel')}
              </Button>
            ) : null}
            {value.status === 'completed' ? (
              <Button
                variant="outlined"
                disabled={busy}
                startIcon={<RefreshCw size={16} aria-hidden="true" />}
                onClick={() => delta.mutate()}
              >
                {t('imports:run.delta')}
              </Button>
            ) : null}
            {value.status === 'completed' ? (
              <Button
                component={Link}
                to={`${ROUTES.tickets}?imported=1&custom=1`}
                variant="contained"
              >
                {t('imports:run.openTickets')}
              </Button>
            ) : null}
          </Box>
          {value.status === 'failed' ? (
            <AlertBanner tone="danger">{t('imports:run.failed')}</AlertBanner>
          ) : null}
        </SectionCard>
      ) : null}
      {['awaiting_mapping', 'ready'].includes(value.status) ? (
        <ImportMappings
          brandId={brandId}
          runId={runId}
          disabled={busy}
          onDirty={setMappingDirty}
          onSaved={async () => {
            updateRun(await api.run(brandId, runId));
          }}
        />
      ) : null}
      {reviewing ? (
        <Field
          id={callingCodeId}
          label={t('imports:dryRun.callingCode')}
          hint={t('imports:dryRun.callingCodeHint')}
        >
          <TextField
            id={callingCodeId}
            size="small"
            value={callingCode ?? report.data?.defaultCallingCode ?? ''}
            disabled={busy || value.status === 'dry_run'}
            slotProps={{
              htmlInput: {
                inputMode: 'numeric',
                maxLength: 4,
                'aria-describedby': `${callingCodeId}-hint`,
                dir: 'ltr',
              },
            }}
            onChange={(event) => {
              if (/^\d{0,4}$/.test(event.target.value)) setCallingCode(event.target.value);
            }}
          />
        </Field>
      ) : null}
      {reviewing && value.hasDryRun ? (
        <ImportDryRun
          run={value}
          report={report.data}
          previews={previews.data?.tickets}
          contacts={previews.data?.contacts}
          startDisabled={callingCode !== null && callingCode !== report.data?.defaultCallingCode}
          previewError={previews.isError}
          busy={busy || mappingDirty}
          failed={report.isError}
          onStart={(input) => start.mutate(input)}
          onRevalidate={() => dryRun.mutate()}
        />
      ) : null}
      {reviewing && !value.hasDryRun ? (
        <SectionCard
          id="import-review-start"
          heading={t('imports:dryRun.title')}
          caption={t('imports:dryRun.caption')}
        >
          <Button
            variant="contained"
            disabled={busy || mappingDirty || value.status === 'dry_run'}
            onClick={() => dryRun.mutate()}
          >
            {t('imports:dryRun.rerun')}
          </Button>
        </SectionCard>
      ) : null}
      {!['draft', 'connecting'].includes(value.status) ? <ImportLog run={value} /> : null}
      {value.status === 'completed' ? <ImportSla run={value} /> : null}
      {!ACTIVE.includes(value.status) &&
      !['paused', 'completed', 'failed', 'cancelled'].includes(value.status) ? (
        <Box>
          <Button
            color="error"
            variant="outlined"
            disabled={busy}
            onClick={() => setConfirmCancel(true)}
          >
            {t('imports:run.cancel')}
          </Button>
        </Box>
      ) : null}
      <ConfirmDialog
        open={confirmCancel}
        title={t('imports:run.cancel')}
        body={t('imports:run.cancelBody')}
        confirmLabel={t('imports:run.cancel')}
        destructive
        busy={control.isPending}
        onConfirm={() => control.mutate('cancel')}
        onClose={() => setConfirmCancel(false)}
      />
    </Box>
  );
}

function ImportProgress({ run }: { run: ImportRunView }) {
  const t = useT();
  const { locale } = usePreferences();
  const number = new Intl.NumberFormat(locale, { numberingSystem: 'latn' });
  return (
    <Box sx={{ display: 'grid', gap: 4 }}>
      {run.scope.entities.map((entity) => {
        const total = run.counts.extracted[entity];
        const loaded = run.counts.loaded[entity] ?? 0;
        const percent = total ? Math.min(100, (loaded / total) * 100) : 0;
        return (
          <Box key={entity} sx={{ display: 'grid', gap: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
              <Typography>{t(`imports:entities.${entity}`)}</Typography>
              <Typography variant="caption">
                <bdi dir="ltr">
                  {number.format(loaded)} / {total === undefined ? '—' : number.format(total)}
                </bdi>
              </Typography>
            </Box>
            {run.status === 'extracting' ? (
              <LinearProgress aria-label={t(`imports:entities.${entity}`)} />
            ) : (
              <LinearProgress
                variant="determinate"
                value={percent}
                aria-label={t(`imports:entities.${entity}`)}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}
