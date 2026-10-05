import type { KnowledgeSourceList, KnowledgeSourceView } from '@helpdock/schemas';
import {
  Box,
  InputAdornment,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Search } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useT } from '../../../../app/i18n.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { knowledgeKeys } from '../../../../knowledge/api.js';
import { useKnowledgeApi } from '../../../../knowledge/context.tsx';
import { leaveTo } from '../../../../knowledge/leave.js';
import { AlertBanner } from '../../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../../ui/confirm-dialog.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { visuallyHidden } from '../../../../ui/visually-hidden.js';
import { SectionCard } from '../../channels/section-card.tsx';
import { AddSourceDialog } from './add-source-dialog.tsx';
import { knowledgeFailure } from './knowledge-format.js';
import { SourceDrawer } from './source-drawer.tsx';
import { SourceRow } from './source-row.tsx';

/**
 * AI › Knowledge (`Admin/AI-Knowledge`, M7-10 on M7-03's api): the brand's
 * sources as SourceRows, the drawer with the sync log, the add-source dialog
 * the page header's "Add source" opens, and removal. A Notion or Drive consent
 * comes back to this url with `?oauth=connected|failed&source=…`, which is
 * said in a banner and opens that source.
 */
export function KnowledgeTab({
  brandId,
  brandName,
  adding,
  onAddingChange,
}: {
  readonly brandId: string;
  readonly brandName: string;
  readonly adding: boolean;
  onAddingChange(adding: boolean): void;
}): ReactNode {
  const t = useT();
  const api = useKnowledgeApi();
  const toast = useToast();
  const tokens = useSemanticTokens();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const oauth = params.get('oauth');
  const [openId, setOpenId] = useState<string | null>(params.get('source'));
  const [removing, setRemoving] = useState<KnowledgeSourceView | null>(null);
  const [search, setSearch] = useState('');
  const sources = useQuery({
    queryKey: knowledgeKeys.sources(brandId),
    queryFn: () => api.sources(brandId),
  });

  const replace = (saved: KnowledgeSourceView): void => {
    queryClient.setQueryData<KnowledgeSourceList>(knowledgeKeys.sources(brandId), (held) =>
      held === undefined
        ? held
        : { ...held, sources: held.sources.map((row) => (row.id === saved.id ? saved : row)) },
    );
  };
  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: knowledgeKeys.sources(brandId) });
  const fail = (error: unknown): void => {
    toast({ tone: 'danger', message: knowledgeFailure(t, error) });
  };

  const sync = useMutation({
    mutationFn: (source: KnowledgeSourceView) => api.syncNow(brandId, source.id),
    onSuccess: (saved) => {
      replace(saved);
      toast({
        tone: 'success',
        message: t('aiSettings:knowledge.syncQueued', { name: saved.name }),
      });
    },
    onError: fail,
  });
  const connect = useMutation({
    mutationFn: (source: KnowledgeSourceView) =>
      api.oauthStart(brandId, source.id, source.kind === 'gdrive' ? 'gdrive' : 'notion'),
    onSuccess: leaveTo,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (source: KnowledgeSourceView) => api.removeSource(brandId, source.id),
    onSuccess: async (_done, source) => {
      setRemoving(null);
      setOpenId(null);
      await refresh();
      toast({
        tone: 'success',
        message: t('aiSettings:knowledge.removeDialog.removed', { name: source.name }),
      });
    },
    onError: fail,
  });

  if (sources.isError) {
    return <AlertBanner tone="danger">{t('aiSettings:loadFailed')}</AlertBanner>;
  }
  if (sources.data === undefined) {
    return <Box aria-busy="true" />;
  }

  const list = sources.data;
  const needle = search.trim().toLowerCase();
  const shown = list.sources.filter((source) => source.name.toLowerCase().includes(needle));
  const open = list.sources.find((source) => source.id === openId) ?? null;
  const chunks = list.sources.reduce((sum, source) => sum + source.embedded, 0);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {oauth === 'connected' ? (
        <AlertBanner tone="info">{t('aiSettings:knowledge.oauth.connected')}</AlertBanner>
      ) : null}
      {oauth === 'failed' ? (
        <AlertBanner tone="danger">{t('aiSettings:knowledge.oauth.failed')}</AlertBanner>
      ) : null}

      <SectionCard
        id="knowledge-sources"
        heading={t('aiSettings:knowledge.heading')}
        caption={t('aiSettings:knowledge.caption', {
          brand: brandName,
          count: list.sources.length,
          chunks: chunks.toLocaleString('en-US'),
          model: list.embedding.model ?? t('aiSettings:knowledge.noModel'),
        })}
        aside={
          <TextField
            size="small"
            value={search}
            placeholder={t('aiSettings:knowledge.search')}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            slotProps={{
              htmlInput: { 'aria-label': t('aiSettings:knowledge.search'), type: 'search' },
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search size={14} aria-hidden="true" />
                  </InputAdornment>
                ),
              },
            }}
          />
        }
      >
        <Box sx={{ marginInline: -5, marginBlockStart: -5, overflowX: 'auto' }}>
          <Table size="small" aria-label={t('aiSettings:knowledge.tableLabel')}>
            <TableHead>
              <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                {(
                  ['source', 'visibility', 'chunks', 'lastSync', 'schedule', 'status'] as const
                ).map((column) => (
                  <TableCell
                    key={column}
                    sx={column === 'chunks' ? { textAlign: 'end' } : undefined}
                  >
                    {t(`aiSettings:knowledge.columns.${column}`)}
                  </TableCell>
                ))}
                <TableCell>
                  <Box component="span" sx={visuallyHidden}>
                    {t('aiSettings:knowledge.columns.actions')}
                  </Box>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {t('aiSettings:knowledge.empty')}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                shown.map((source) => (
                  <SourceRow
                    key={source.id}
                    source={source}
                    open={source.id === openId}
                    busy={sync.isPending && sync.variables.id === source.id}
                    onOpen={() => {
                      setOpenId(source.id);
                    }}
                    onSync={() => {
                      sync.mutate(source);
                    }}
                    onConnect={() => {
                      connect.mutate(source);
                    }}
                    onRemove={() => {
                      setRemoving(source);
                    }}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </Box>
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', display: 'inline-flex', gap: 1, alignItems: 'flex-start' }}
        >
          <Info size={14} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
          {t('aiSettings:knowledge.footer')}
        </Typography>
      </SectionCard>

      <AddSourceDialog
        open={adding}
        brandId={brandId}
        list={list}
        onClose={() => {
          onAddingChange(false);
        }}
        onAdded={(message) => {
          onAddingChange(false);
          toast({ tone: 'success', message });
          void refresh();
        }}
      />

      <SourceDrawer
        brandId={brandId}
        source={open}
        onClose={() => {
          setOpenId(null);
        }}
        onChanged={replace}
        onSync={() => {
          if (open !== null) {
            sync.mutate(open);
          }
        }}
        onConnect={() => {
          if (open !== null) {
            connect.mutate(open);
          }
        }}
        onRemove={() => {
          setRemoving(open);
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        title={t('aiSettings:knowledge.removeDialog.title', { name: removing?.name ?? '' })}
        body={t('aiSettings:knowledge.removeDialog.body', { count: removing?.chunks ?? 0 })}
        confirmLabel={t('aiSettings:knowledge.removeDialog.confirm')}
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing);
          }
        }}
        onClose={() => {
          setRemoving(null);
        }}
      />
    </Box>
  );
}
