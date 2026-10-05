import type {
  KnowledgeLogLine,
  KnowledgeSourceUpdate,
  KnowledgeSourceView,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  Drawer,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, Trash2, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { knowledgeKeys } from '../../../../knowledge/api.js';
import { useKnowledgeApi } from '../../../../knowledge/context.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { dayOf, timeOf } from '../format.js';
import { knowledgeFailure } from './knowledge-format.js';
import { logLineText } from './log-format.js';
import { detailOf } from './source-format.js';
import { Status } from './source-row.tsx';

/**
 * The source drawer of `Admin/AI-Knowledge`: the state with its progress, the
 * facts (visibility and schedule are changed here), the pages or folders a
 * connector reads, and the SyncLog — newest first, its lines translated from
 * the api's codes — with Remove and Sync now at its foot.
 */
export function SourceDrawer({
  brandId,
  source,
  onClose,
  onChanged,
  onSync,
  onConnect,
  onRemove,
}: {
  readonly brandId: string;
  readonly source: KnowledgeSourceView | null;
  onClose(): void;
  onChanged(source: KnowledgeSourceView): void;
  onSync(): void;
  onConnect(): void;
  onRemove(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();

  return (
    <Drawer
      anchor="right"
      open={source !== null}
      onClose={onClose}
      slotProps={{
        paper: { 'aria-labelledby': headingId, sx: { width: { xs: '100%', sm: 440 } } } as object,
      }}
    >
      {source === null ? null : (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 2,
              padding: 5,
              borderBlockEnd: `1px solid ${tokens['border.default']}`,
            }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
                <bdi>{source.name}</bdi>
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {detailOf(t, source)}
              </Typography>
            </Box>
            <IconButton
              size="small"
              aria-label={t('aiSettings:knowledge.drawer.close')}
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </IconButton>
          </Box>

          <Box
            sx={{
              flex: 1,
              overflowY: 'auto',
              padding: 5,
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
            }}
          >
            <Status source={source} onConnect={onConnect} />
            <Facts brandId={brandId} source={source} onChanged={onChanged} />
            {source.config.kind === 'notion' || source.config.kind === 'gdrive' ? (
              source.config.connected ? (
                <Picker key={source.id} brandId={brandId} source={source} onChanged={onChanged} />
              ) : null
            ) : null}
            <SyncLog brandId={brandId} source={source} />
          </Box>

          <Box
            sx={{
              display: 'flex',
              gap: 2,
              padding: 4,
              borderBlockStart: `1px solid ${tokens['border.default']}`,
            }}
          >
            {source.kind === 'article' ? null : (
              <Button
                variant="outlined"
                color="error"
                startIcon={<Trash2 size={14} aria-hidden="true" />}
                onClick={onRemove}
              >
                {t('aiSettings:knowledge.remove')}
              </Button>
            )}
            <Box sx={{ flex: 1 }} />
            <Button
              variant="outlined"
              startIcon={<RefreshCw size={14} aria-hidden="true" />}
              disabled={source.status.state === 'syncing' || source.status.state === 'queued'}
              onClick={onSync}
            >
              {source.status.state === 'syncing' || source.status.state === 'queued'
                ? t('aiSettings:knowledge.syncing')
                : t('aiSettings:knowledge.syncNow')}
            </Button>
          </Box>
        </Box>
      )}
    </Drawer>
  );
}

function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      {children}
    </Box>
  );
}

function Facts({
  brandId,
  source,
  onChanged,
}: {
  readonly brandId: string;
  readonly source: KnowledgeSourceView;
  onChanged(source: KnowledgeSourceView): void;
}): ReactNode {
  const t = useT();
  const api = useKnowledgeApi();
  const toast = useToast();
  const { locale } = usePreferences();
  const id = useId();
  const update = useMutation({
    mutationFn: (request: KnowledgeSourceUpdate) => api.updateSource(brandId, source.id, request),
    onSuccess: (saved) => {
      onChanged(saved);
      toast({
        tone: 'success',
        message: t('aiSettings:knowledge.drawer.saved', { name: saved.name }),
      });
    },
    onError: (error: unknown) => {
      toast({ tone: 'danger', message: knowledgeFailure(t, error) });
    },
  });
  const editable = source.kind !== 'article';
  const chooseSchedule = editable && source.schedule !== 'automatic';

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
      <Fact label={t('aiSettings:knowledge.drawer.visibility')}>
        {editable && source.visibility !== null ? (
          <Select
            size="small"
            value={source.visibility}
            disabled={update.isPending}
            inputProps={{
              'aria-label': t('aiSettings:knowledge.drawer.visibility'),
              id: `${id}-visibility`,
            }}
            onChange={(event) => {
              update.mutate({
                visibility: event.target.value === 'public' ? 'public' : 'internal',
              });
            }}
          >
            <MenuItem value="internal">{t('aiSettings:knowledge.visibility.internal')}</MenuItem>
            <MenuItem value="public">{t('aiSettings:knowledge.visibility.public')}</MenuItem>
          </Select>
        ) : (
          <Typography variant="body2">{t('aiSettings:knowledge.visibility.perArticle')}</Typography>
        )}
      </Fact>
      <Fact label={t('aiSettings:knowledge.drawer.chunks')}>
        <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
          {source.chunks.toLocaleString('en-US')}
        </Typography>
      </Fact>
      {source.config.kind === 'crawl' ? (
        <>
          <Fact label={t('aiSettings:knowledge.drawer.pages')}>
            <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
              {t('aiSettings:knowledge.drawer.pagesValue', {
                done: source.status.progress?.done ?? source.documents,
                max: source.config.crawl.maxPages,
              })}
            </Typography>
          </Fact>
          <Fact label={t('aiSettings:knowledge.drawer.rendering')}>
            <Typography variant="body2">
              {source.config.crawl.render
                ? t('aiSettings:knowledge.drawer.renderingOn')
                : t('aiSettings:knowledge.drawer.renderingOff')}
            </Typography>
          </Fact>
        </>
      ) : null}
      <Fact label={t('aiSettings:knowledge.drawer.schedule')}>
        {chooseSchedule ? (
          <Select
            size="small"
            value={source.schedule}
            disabled={update.isPending}
            inputProps={{ 'aria-label': t('aiSettings:knowledge.drawer.schedule') }}
            onChange={(event) => {
              const schedule = event.target.value;
              if (schedule === 'daily' || schedule === 'weekly' || schedule === 'manual') {
                update.mutate({ schedule });
              }
            }}
          >
            {(['daily', 'weekly', 'manual'] as const).map((schedule) => (
              <MenuItem key={schedule} value={schedule}>
                {t(`aiSettings:knowledge.addDialog.schedules.${schedule}`)}
              </MenuItem>
            ))}
          </Select>
        ) : (
          <Typography variant="body2">
            {source.kind === 'article'
              ? t('aiSettings:knowledge.schedule.automaticArticle')
              : t('aiSettings:knowledge.schedule.automaticFile')}
          </Typography>
        )}
        {source.nextSyncAt === null ? null : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('aiSettings:knowledge.drawer.next', {
              date: dayOf(new Date(source.nextSyncAt), locale),
            })}
          </Typography>
        )}
      </Fact>
      <Fact label={t('aiSettings:knowledge.drawer.added')}>
        <Typography variant="body2">
          {t('aiSettings:knowledge.drawer.addedValue', {
            date: dayOf(new Date(source.createdAt), locale),
            who: source.createdBy ?? '—',
          })}
        </Typography>
      </Fact>
    </Box>
  );
}

/** The Notion pages and databases, or Drive folders, a connected source reads. */
function Picker({
  brandId,
  source,
  onChanged,
}: {
  readonly brandId: string;
  readonly source: KnowledgeSourceView;
  onChanged(source: KnowledgeSourceView): void;
}): ReactNode {
  const t = useT();
  const api = useKnowledgeApi();
  const toast = useToast();
  const id = useId();
  const notion = source.config.kind === 'notion';
  const chosen =
    source.config.kind === 'notion'
      ? [...source.config.notion.pageIds, ...source.config.notion.databaseIds]
      : source.config.kind === 'gdrive'
        ? source.config.gdrive.folderIds
        : [];
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(chosen));
  const items = useQuery({
    queryKey: knowledgeKeys.browse(brandId, source.id, query),
    queryFn: () => api.browse(brandId, source.id, query),
  });
  const save = useMutation({
    mutationFn: () => {
      const all = items.data?.items ?? [];
      const ids = [...selected];
      const config = notion
        ? {
            pageIds: ids.filter(
              (item) => all.find((found) => found.id === item)?.kind !== 'database',
            ),
            databaseIds: ids.filter(
              (item) => all.find((found) => found.id === item)?.kind === 'database',
            ),
          }
        : { folderIds: ids };
      return api.updateSource(brandId, source.id, { config });
    },
    onSuccess: (saved) => {
      onChanged(saved);
      toast({
        tone: 'success',
        message: t('aiSettings:knowledge.drawer.saved', { name: saved.name }),
      });
    },
    onError: (error: unknown) => {
      toast({ tone: 'danger', message: knowledgeFailure(t, error) });
    },
  });

  return (
    <Box
      component="fieldset"
      sx={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <Typography component="legend" sx={{ fontSize: 14, fontWeight: 600, marginBlockEnd: 2 }}>
        {t(`aiSettings:knowledge.drawer.pick.${notion ? 'notion' : 'gdrive'}`)}
      </Typography>
      {notion ? (
        <TextField
          size="small"
          id={`${id}-search`}
          value={query}
          placeholder={t('aiSettings:knowledge.drawer.pickSearch')}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          slotProps={{ htmlInput: { 'aria-label': t('aiSettings:knowledge.drawer.pickSearch') } }}
        />
      ) : null}
      {items.isError ? (
        <Typography variant="caption" role="alert">
          {knowledgeFailure(t, items.error)}
        </Typography>
      ) : items.data?.items.length === 0 ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:knowledge.drawer.pickEmpty')}
        </Typography>
      ) : (
        (items.data?.items ?? []).map((item) => (
          <FormControlLabel
            key={item.id}
            control={
              <Checkbox
                size="small"
                checked={selected.has(item.id)}
                onChange={(event) => {
                  setSelected((held) => {
                    const next = new Set(held);
                    if (event.target.checked) {
                      next.add(item.id);
                    } else {
                      next.delete(item.id);
                    }
                    return next;
                  });
                }}
              />
            }
            label={<bdi>{item.title}</bdi>}
          />
        ))
      )}
      <Button
        variant="outlined"
        sx={{ alignSelf: 'flex-start' }}
        disabled={save.isPending}
        onClick={() => save.mutate()}
      >
        {t('aiSettings:knowledge.drawer.pickSave')}
      </Button>
    </Box>
  );
}

function SyncLog({
  brandId,
  source,
}: {
  readonly brandId: string;
  readonly source: KnowledgeSourceView;
}): ReactNode {
  const t = useT();
  const api = useKnowledgeApi();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const id = useId();
  const [level, setLevel] = useState<'all' | 'warn'>('all');
  const log = useQuery({
    queryKey: knowledgeKeys.log(brandId, source.id, level),
    queryFn: () => api.log(brandId, source.id, level),
  });
  const lines: readonly KnowledgeLogLine[] = log.data?.lines ?? [];
  const levelColour = (line: KnowledgeLogLine): string =>
    line.level === 'warn'
      ? tokens['status.warning.text']
      : line.level === 'error'
        ? tokens['status.danger.text']
        : line.level === 'done'
          ? tokens['status.success.text']
          : tokens['text.secondary'];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
          {t('aiSettings:knowledge.drawer.log')}
        </Typography>
        <Select
          size="small"
          value={level}
          inputProps={{
            'aria-label': t('aiSettings:knowledge.drawer.logFilter'),
            id: `${id}-level`,
          }}
          onChange={(event) => {
            setLevel(event.target.value === 'warn' ? 'warn' : 'all');
          }}
        >
          <MenuItem value="all">{t('aiSettings:knowledge.drawer.logAll')}</MenuItem>
          <MenuItem value="warn">{t('aiSettings:knowledge.drawer.logWarn')}</MenuItem>
        </Select>
      </Box>
      {log.isError ? (
        <Typography variant="caption" role="alert">
          {t('aiSettings:loadFailed')}
        </Typography>
      ) : lines.length === 0 && log.data !== undefined ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('aiSettings:knowledge.drawer.logEmpty')}
        </Typography>
      ) : (
        <Box
          component="ol"
          aria-label={t('aiSettings:knowledge.drawer.logLabel', { name: source.name })}
          sx={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          {lines.map((line) => (
            <Box
              component="li"
              key={line.id}
              sx={{
                display: 'grid',
                gridTemplateColumns: '64px 44px minmax(0, 1fr)',
                gap: 2,
                paddingBlock: 2,
                borderBlockEnd: `1px solid ${tokens['bg.muted']}`,
              }}
            >
              <Typography
                variant="mono"
                component="span"
                sx={{ fontSize: 12, color: 'text.secondary' }}
              >
                {timeOf(line.at, locale)}
              </Typography>
              <Typography
                variant="mono"
                component="span"
                sx={{ fontSize: 12, color: levelColour(line) }}
              >
                {t(`aiSettings:knowledge.drawer.levels.${line.level}`)}
              </Typography>
              <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
                {logLineText(t, line)}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
