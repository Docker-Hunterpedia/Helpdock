import type { KnowledgeSourceView } from '@helpdock/schemas';
import { Box, Button, Link, TableCell, TableRow, Typography } from '@mui/material';
import {
  BookOpen,
  FileText,
  FolderOpen,
  Globe,
  HardDrive,
  Lock,
  type LucideIcon,
  NotebookText,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { ActionsMenu, type MenuAction } from '../../../../ui/actions-menu.tsx';
import { detailOf, needsConnection, scheduleOf, stateOf, whenOf } from './source-format.js';

/**
 * DESIGN §6.3 SourceRow (`Admin/AI-Knowledge`): the kind's tile, the name as
 * the way into the drawer over its caption, visibility as an icon and a word,
 * chunks, last sync, schedule, the state in the StatusBadge shape with its
 * progress or its reason, "Sync now" named after the source, and the menu.
 */

const KIND_ICONS: Readonly<Record<KnowledgeSourceView['kind'], LucideIcon>> = {
  article: BookOpen,
  file: FileText,
  crawl: Globe,
  notion: NotebookText,
  gdrive: HardDrive,
};

export function SourceRow({
  source,
  open,
  busy,
  onOpen,
  onSync,
  onConnect,
  onRemove,
}: {
  readonly source: KnowledgeSourceView;
  readonly open: boolean;
  readonly busy: boolean;
  onOpen(): void;
  onSync(): void;
  onConnect(): void;
  onRemove(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const Icon = KIND_ICONS[source.kind];
  const running = source.status.state === 'syncing' || source.status.state === 'queued';
  const connect = needsConnection(source);
  const actions: MenuAction[] = [
    {
      id: 'open',
      label: t('aiSettings:knowledge.open', { name: source.name }),
      icon: FolderOpen,
      onSelect: onOpen,
    },
    ...(source.kind === 'article'
      ? []
      : [
          {
            id: 'remove',
            label: t('aiSettings:knowledge.remove'),
            icon: Trash2,
            tone: 'danger' as const,
            dividerBefore: true,
            onSelect: onRemove,
          },
        ]),
  ];

  return (
    <TableRow
      sx={{
        backgroundColor: open ? tokens['action.primary.tint'] : undefined,
        boxShadow: open ? `inset 3px 0 0 ${tokens['action.primary']}` : undefined,
        '& td': { paddingBlock: 2, paddingInline: 4, verticalAlign: 'middle' },
      }}
    >
      <TableCell>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, minWidth: 0 }}>
          <Box
            aria-hidden="true"
            sx={{
              width: 28,
              height: 28,
              flexShrink: 0,
              borderRadius: '6px',
              display: 'grid',
              placeItems: 'center',
              backgroundColor: tokens['bg.muted'],
            }}
          >
            <Icon size={14} />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Link
              component="button"
              type="button"
              onClick={onOpen}
              underline="hover"
              sx={{ fontSize: 13, fontWeight: 500, textAlign: 'start', color: 'text.primary' }}
            >
              <bdi>{source.name}</bdi>
            </Link>
            <Typography variant="caption" sx={{ color: 'text.secondary' }} noWrap>
              {detailOf(t, source)}
            </Typography>
          </Box>
        </Box>
      </TableCell>
      <TableCell>
        <Visibility source={source} />
      </TableCell>
      <TableCell sx={{ textAlign: 'end' }}>
        <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
          {source.chunks.toLocaleString('en-US')}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography variant="mono" component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
          {source.lastSyncedAt === null
            ? t('aiSettings:knowledge.never')
            : whenOf(source.lastSyncedAt, locale)}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography variant="caption">{scheduleOf(t, source)}</Typography>
      </TableCell>
      <TableCell sx={{ minWidth: 200 }}>
        <Status source={source} onConnect={onConnect} />
      </TableCell>
      <TableCell sx={{ textAlign: 'end', whiteSpace: 'nowrap' }}>
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
          {connect && !running ? (
            <Button size="small" variant="outlined" onClick={onConnect}>
              {t('aiSettings:knowledge.connect')}
            </Button>
          ) : (
            <Button
              size="small"
              variant="outlined"
              disabled={running || busy}
              startIcon={<RefreshCw size={14} aria-hidden="true" />}
              aria-label={
                running ? undefined : t('aiSettings:knowledge.syncNowLabel', { name: source.name })
              }
              onClick={onSync}
            >
              {running ? t('aiSettings:knowledge.syncing') : t('aiSettings:knowledge.syncNow')}
            </Button>
          )}
          <ActionsMenu
            label={t('aiSettings:knowledge.menu', { name: source.name })}
            menuLabel={t('aiSettings:knowledge.menu', { name: source.name })}
            items={actions}
          />
        </Box>
      </TableCell>
    </TableRow>
  );
}

export function Visibility({ source }: { readonly source: KnowledgeSourceView }): ReactNode {
  const t = useT();
  const Icon =
    source.visibility === 'public' ? Globe : source.visibility === 'internal' ? Lock : FileText;
  const word =
    source.visibility === null
      ? t('aiSettings:knowledge.visibility.perArticle')
      : t(`aiSettings:knowledge.visibility.${source.visibility}`);
  return (
    <Typography variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <Icon size={14} aria-hidden="true" />
      {word}
    </Typography>
  );
}

/** The state in the StatusBadge shape, then the bar while syncing or the reason after a failure. */
export function Status({
  source,
  onConnect,
}: {
  readonly source: KnowledgeSourceView;
  onConnect(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { state, progress, reason, code } = source.status;
  const tone =
    state === 'ok'
      ? 'success'
      : state === 'failed'
        ? 'danger'
        : state === 'syncing' || state === 'queued'
          ? 'info'
          : null;
  const percent =
    progress === null || progress.total === null || progress.total === 0
      ? null
      : Math.min(100, Math.round((progress.done / progress.total) * 100));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start' }}>
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1,
          paddingInline: 2,
          height: 20,
          borderRadius: '6px',
          fontSize: 12,
          fontWeight: 500,
          backgroundColor: tone === null ? tokens['bg.muted'] : tokens[`status.${tone}.tint`],
          color: tone === null ? 'text.secondary' : tokens[`status.${tone}.text`],
        }}
      >
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            width: 6,
            height: 6,
            borderRadius: '999px',
            backgroundColor: tone === null ? tokens['border.strong'] : tokens[`status.${tone}`],
          }}
        />
        {stateOf(t, source)}
      </Box>
      {state === 'syncing' && percent !== null ? (
        <Box
          role="progressbar"
          aria-label={t('aiSettings:knowledge.progressLabel', { name: source.name })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          sx={{
            width: '100%',
            height: 4,
            borderRadius: '999px',
            backgroundColor: tokens['border.default'],
          }}
        >
          <Box
            sx={{
              width: `${String(percent)}%`,
              height: '100%',
              borderRadius: '999px',
              backgroundColor: tokens['status.info'],
            }}
          />
        </Box>
      ) : null}
      {state === 'failed' && reason !== null ? (
        <Typography variant="caption" sx={{ color: tokens['status.danger.text'] }}>
          {reason}
          {code === 'auth' ? (
            <>
              {' · '}
              <Link
                component="button"
                type="button"
                onClick={onConnect}
                sx={{ fontSize: 12, verticalAlign: 'baseline' }}
              >
                {t('aiSettings:knowledge.reconnect')}
              </Link>
            </>
          ) : null}
        </Typography>
      ) : null}
    </Box>
  );
}
