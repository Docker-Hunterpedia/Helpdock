import type { EmbeddingSettingsUpdate, EmbeddingSettingsView } from '@helpdock/schemas';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { aiKeys } from '../../../../ai/api.js';
import { useAiApi } from '../../../../ai/context.tsx';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../../ui/confirm-dialog.tsx';
import { EnvChip } from '../../../../ui/env-locked-field.tsx';
import { Field, fieldDescribedBy } from '../../../../ui/field.tsx';
import { SecretField } from '../../../../ui/secret-field.tsx';
import { SectionCard } from '../../channels/section-card.tsx';
import { useAiAction } from '../use-ai-action.js';
import {
  changesSpace,
  type EmbeddingDraft,
  type EmbeddingField,
  type EmbeddingProblem,
  embeddingDraftOf,
  embeddingRequestOf,
} from './embedding-draft.js';

/**
 * The Embeddings card of `Admin/AI-Providers` (M7-02, ADR 0005): one model for
 * the whole install, its status, and the re-embed's progress. Changing the
 * model or the dimension re-embeds every chunk of every brand, so it is asked
 * first in a dialog that says what happens; nothing here can be changed while
 * a re-embed runs.
 */

type FullRequest = Omit<EmbeddingSettingsUpdate, 'confirmReembed'>;

export function EmbeddingsCard({
  settings,
}: {
  readonly settings: EmbeddingSettingsView;
}): ReactNode {
  const t = useT();
  const api = useAiApi();
  const queryClient = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<EmbeddingDraft>(() => embeddingDraftOf(settings));
  const [problems, setProblems] = useState<Partial<Record<EmbeddingField, EmbeddingProblem>>>({});
  const [confirming, setConfirming] = useState<FullRequest | null>(null);

  useEffect(() => {
    setDraft(embeddingDraftOf(settings));
  }, [settings]);

  const save = useAiAction(
    (request: EmbeddingSettingsUpdate) => api.saveEmbedding(request),
    t('aiSettings:embeddings.saved'),
    (saved) => {
      setConfirming(null);
      queryClient.setQueryData(aiKeys.embedding, saved);
    },
  );

  const { space } = settings;
  const reindexing = space.status === 'reindexing';
  const locked = settings.lockedKeys.length > 0;
  const frozen = reindexing || locked;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const outcome = embeddingRequestOf(draft);
    if (!outcome.ok) {
      setProblems(outcome.problems);
      return;
    }
    setProblems({});
    if (changesSpace(settings, outcome.request)) {
      setConfirming(outcome.request);
      return;
    }
    save.mutate(outcome.request);
  };

  const set = (patch: Partial<EmbeddingDraft>): void => {
    setDraft((held) => ({ ...held, ...patch }));
  };
  const problemText = (field: EmbeddingField): string | undefined => {
    const problem = problems[field];
    return problem === undefined
      ? undefined
      : t(`aiSettings:embeddings.problems.${problem}`, { dims: draft.dims });
  };

  const text = (
    field: 'provider' | 'baseUrl' | 'model' | 'dims' | 'price',
    label: string,
    hint?: string,
  ) => {
    const error = problemText(field);
    return (
      <Field id={`${id}-${field}`} label={label} hint={hint} error={error}>
        <TextField
          id={`${id}-${field}`}
          size="small"
          value={draft[field]}
          disabled={frozen}
          error={error !== undefined}
          onChange={(event) => {
            set({ [field]: event.target.value });
          }}
          slotProps={{
            htmlInput: {
              dir: 'ltr',
              spellCheck: false,
              ...(field === 'dims' || field === 'price' ? { inputMode: 'decimal' as const } : {}),
              'aria-invalid': error !== undefined,
              'aria-describedby': fieldDescribedBy(`${id}-${field}`, { hint, error }),
            },
          }}
        />
      </Field>
    );
  };

  return (
    <SectionCard
      id={`${id}-embeddings`}
      heading={t('aiSettings:embeddings.heading')}
      caption={t('aiSettings:embeddings.caption')}
      aside={locked ? <EnvChip /> : <StatusWord settings={settings} />}
      onSubmit={submit}
      footer={
        frozen ? undefined : (
          <>
            <Button
              variant="text"
              disabled={save.isPending}
              onClick={() => {
                setDraft(embeddingDraftOf(settings));
                setProblems({});
              }}
            >
              {t('aiSettings:discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={save.isPending}>
              {t('aiSettings:save')}
            </Button>
          </>
        )
      }
    >
      {reindexing ? (
        <AlertBanner tone="info">
          {t('aiSettings:embeddings.reindexing', {
            model: space.targetModel ?? '',
            dims: space.targetDims ?? 0,
          })}
        </AlertBanner>
      ) : null}
      {space.lastError === null ? null : (
        <AlertBanner tone="danger">
          {t('aiSettings:embeddings.failed', { error: space.lastError })}
        </AlertBanner>
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1fr)' },
          gap: 3,
        }}
      >
        {text(
          'baseUrl',
          t('aiSettings:embeddings.endpoint'),
          t('aiSettings:embeddings.endpointHint'),
        )}
        {text('model', t('aiSettings:embeddings.model'))}
        {text('dims', t('aiSettings:embeddings.dims'), t('aiSettings:embeddings.dimsHint'))}
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
          gap: 3,
        }}
      >
        {text('provider', t('aiSettings:embeddings.provider'))}
        {text('price', t('aiSettings:embeddings.price'))}
        <SecretField
          id={`${id}-key`}
          label={t('aiSettings:embeddings.apiKey')}
          stored={settings.hasApiKey}
          value={draft.apiKey}
          replaceLabel={t('aiSettings:embeddings.replaceKey')}
          onChange={(apiKey) => {
            set({ apiKey });
          }}
        />
      </Box>

      <Progress settings={settings} />
      {reindexing ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:embeddings.frozen')}
        </Typography>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        title={t('aiSettings:embeddings.dialog.title')}
        body={t('aiSettings:embeddings.dialog.body', { chunks: space.progress.total })}
        confirmLabel={t('aiSettings:embeddings.dialog.confirm')}
        busy={save.isPending}
        onConfirm={() => {
          if (confirming !== null) {
            save.mutate({ ...confirming, confirmReembed: true });
          }
        }}
        onClose={() => {
          setConfirming(null);
        }}
      >
        {confirming === null ? null : <ModelChange settings={settings} next={confirming} />}
      </ConfirmDialog>
    </SectionCard>
  );
}

function StatusWord({ settings }: { readonly settings: EmbeddingSettingsView }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { status, progress } = settings.space;
  const percent = progress.total === 0 ? 0 : Math.floor((progress.embedded / progress.total) * 100);
  const colour = {
    ready: tokens['status.success'],
    reindexing: tokens['status.warning'],
    unconfigured: tokens['border.strong'],
  }[status];

  return (
    <Typography
      variant="caption"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontWeight: 500 }}
    >
      <Box
        component="span"
        aria-hidden="true"
        sx={{ width: 8, height: 8, borderRadius: '999px', backgroundColor: colour }}
      />
      {t(`aiSettings:embeddings.status.${status}`, { percent })}
    </Typography>
  );
}

/** The re-embed across every brand: SourceRow's parts, one row until per-source progress lands. */
function Progress({ settings }: { readonly settings: EmbeddingSettingsView }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { status, progress, activeModel, activeDims } = settings.space;
  if (status === 'unconfigured') {
    return null;
  }
  const done = progress.total > 0 && progress.embedded >= progress.total;
  const percent =
    progress.total === 0 ? 100 : Math.floor((progress.embedded / progress.total) * 100);

  if (status === 'ready') {
    return (
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('aiSettings:embeddings.readyLine', {
          model: activeModel ?? '',
          dims: activeDims ?? 0,
          chunks: progress.total,
        })}
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
        {t('aiSettings:embeddings.progressHeading')}
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 120px auto auto',
          alignItems: 'center',
          gap: 3,
          minHeight: 32,
        }}
      >
        <Typography variant="body2">{t('aiSettings:embeddings.allBrands')}</Typography>
        <Box
          role="progressbar"
          aria-label={t('aiSettings:embeddings.progressLabel')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          sx={{ height: 4, borderRadius: '999px', backgroundColor: tokens['border.default'] }}
        >
          <Box
            sx={{
              height: '100%',
              width: `${String(percent)}%`,
              borderRadius: '999px',
              backgroundColor: done ? tokens['status.success'] : tokens['status.info'],
            }}
          />
        </Box>
        <Typography variant="mono" component="span" dir="ltr" sx={{ fontSize: 12 }}>
          {progress.embedded.toLocaleString('en-US')} / {progress.total.toLocaleString('en-US')}
        </Typography>
        <Typography variant="caption" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
          {done ? <Check size={14} aria-hidden="true" /> : null}
          {done ? t('aiSettings:embeddings.done') : `${String(percent)} %`}
        </Typography>
      </Box>
    </Box>
  );
}

/** The dialog's "from → to" box and what happens next. */
function ModelChange({
  settings,
  next,
}: {
  readonly settings: EmbeddingSettingsView;
  readonly next: FullRequest;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box
        dir="ltr"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: 3,
          borderRadius: '6px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.canvas'],
        }}
      >
        <Typography variant="mono" component="span" sx={{ fontSize: 12, flex: 1 }}>
          {settings.model} · {settings.dims}
        </Typography>
        <ArrowRight size={14} aria-label={t('aiSettings:embeddings.dialog.to')} />
        <Typography variant="mono" component="span" sx={{ fontSize: 12, flex: 1, fontWeight: 600 }}>
          {next.model} · {next.dims}
        </Typography>
      </Box>
      <Box
        component="ul"
        sx={{ margin: 0, paddingInlineStart: 5, display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        {(['fallback', 'dropped', 'failure'] as const).map((point) => (
          <Typography component="li" variant="body2" key={point} sx={{ color: 'text.secondary' }}>
            {t(`aiSettings:embeddings.dialog.${point}`)}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}
