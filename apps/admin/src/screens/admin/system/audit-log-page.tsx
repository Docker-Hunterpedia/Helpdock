import type { AuditLogPage as AuditPage, AuditRecord } from '@helpdock/schemas';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Paper,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ScrollText,
  ServerCog,
  ShieldAlert,
} from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { EmptyState } from '../../../shell/empty-state.js';
import { PageHeader } from '../../../shell/page-header.js';
import { useDebounced } from '../../../ui/use-debounced.js';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import {
  ACTION_OPTIONS,
  type AuditFilters,
  auditStamp,
  hasFilters,
  initialsOf,
  NO_FILTERS,
  queryOf,
  TARGET_OPTIONS,
  userAgentSummary,
  utcOffsetLabel,
} from './audit-format.js';
import {
  AUDIT_LOG_QUERY_KEY,
  HttpSystemApi,
  NotAllowedError,
  type SystemApi,
} from './system-api.js';

/**
 * The admin audit log viewer (M3-08, artboard `AdminAuditLog`): install-wide,
 * newest first, filtered by actor, action, target, brand and date, fifty rows a
 * page, each row expanding into what it changed.
 *
 * Read only. Nothing here edits or deletes a row, and nothing here redacts
 * either: the api has already replaced every secret with `[redacted]`, so the
 * page cannot show one by forgetting to hide it.
 */

/** How long the actor box waits for typing to stop before it asks. */
const ACTOR_DEBOUNCE_MS = 300;

export function AuditLogPage({ api }: { readonly api?: SystemApi } = {}): ReactNode {
  const t = useT();
  const client = useMemo(() => api ?? new HttpSystemApi(), [api]);
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  // Every cursor that led to the page shown, so Newer is a step back.
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const actor = useDebounced(filters.actor, ACTOR_DEBOUNCE_MS);
  const cursor = cursors.at(-1) ?? null;
  const settled = { ...filters, actor };

  const page = useQuery({
    queryKey: [...AUDIT_LOG_QUERY_KEY, settled, cursor],
    queryFn: () => client.auditLog(queryOf(settled, cursor)),
    retry: false,
  });

  const change = (patch: Partial<AuditFilters>): void => {
    setFilters((held) => ({ ...held, ...patch }));
    setCursors([null]);
  };

  const back = (
    <Button
      component={RouterLink}
      to={ROUTES.system}
      variant="outlined"
      size="small"
      startIcon={<ArrowLeft size={16} aria-hidden="true" />}
    >
      {t('system:auditLog.back')}
    </Button>
  );
  const header = (
    <PageHeader
      title={t('system:auditLog.title')}
      caption={t('system:auditLog.caption')}
      action={back}
    />
  );

  if (page.error) {
    const notAllowed = page.error instanceof NotAllowedError;
    return (
      <>
        {header}
        <EmptyState
          icon={notAllowed ? ShieldAlert : ServerCog}
          heading={t(notAllowed ? 'system:notAllowed.heading' : 'system:error.heading')}
          body={t(notAllowed ? 'system:notAllowed.body' : 'system:error.body')}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <FilterBar filters={filters} brands={page.data?.brands ?? []} onChange={change} />

      {page.isPending ? (
        <Box role="status" aria-live="polite" sx={{ display: 'grid', gap: 2 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('system:auditLog.loading')}
          </Typography>
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} variant="rounded" height={44} />
          ))}
        </Box>
      ) : page.data.entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          heading={t('system:auditLog.empty.heading')}
          body={t('system:auditLog.empty.body')}
          {...(hasFilters(filters)
            ? {
                action: (
                  <Button
                    variant="outlined"
                    onClick={() => {
                      change(NO_FILTERS);
                    }}
                  >
                    {t('system:auditLog.filters.clear')}
                  </Button>
                ),
              }
            : {})}
        />
      ) : (
        <Entries
          page={page.data}
          open={open}
          onToggle={(id) => {
            setOpen((held) => {
              const next = new Set(held);
              if (next.has(id)) {
                next.delete(id);
              } else {
                next.add(id);
              }
              return next;
            });
          }}
          newer={
            cursors.length > 1
              ? () => {
                  setCursors((held) => held.slice(0, -1));
                }
              : null
          }
          older={
            page.data.nextCursor === null
              ? null
              : () => {
                  const next = page.data.nextCursor;
                  setCursors((held) => [...held, next]);
                }
          }
        />
      )}

      <Typography
        variant="caption"
        component="p"
        sx={{ color: 'text.secondary', marginBlockStart: 4 }}
      >
        {t('system:auditLog.readOnly')}
      </Typography>
    </>
  );
}

function FilterBar({
  filters,
  brands,
  onChange,
}: {
  readonly filters: AuditFilters;
  readonly brands: AuditPage['brands'];
  onChange(patch: Partial<AuditFilters>): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const actorId = useId();
  const actionId = useId();
  const targetId = useId();
  const brandId = useId();

  const label = (id: string, text: string): ReactNode => (
    <Typography component="label" htmlFor={id} sx={{ fontSize: 13, fontWeight: 500 }}>
      {text}
    </Typography>
  );

  return (
    <Paper
      component="form"
      role="search"
      aria-label={t('system:auditLog.filters.label')}
      onSubmit={(event) => {
        event.preventDefault();
      }}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        gap: 3,
        padding: 4,
        marginBlockEnd: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        boxShadow: 'none',
      }}
    >
      <Box sx={{ display: 'grid', gap: '6px', minWidth: 180 }}>
        {label(actorId, t('system:auditLog.filters.actor'))}
        <TextField
          id={actorId}
          size="small"
          type="search"
          value={filters.actor}
          placeholder={t('system:auditLog.filters.anyone')}
          onChange={(event) => {
            onChange({ actor: event.target.value });
          }}
        />
      </Box>
      <Box sx={{ display: 'grid', gap: '6px', minWidth: 180 }}>
        {label(actionId, t('system:auditLog.filters.action'))}
        <TextField
          id={actionId}
          select
          size="small"
          value={filters.action}
          onChange={(event) => {
            onChange({ action: event.target.value });
          }}
          slotProps={{
            select: { displayEmpty: true },
            htmlInput: { 'aria-label': t('system:auditLog.filters.action') },
          }}
        >
          <MenuItem value="">{t('system:auditLog.filters.anyAction')}</MenuItem>
          {ACTION_OPTIONS.map((action) => (
            <MenuItem key={action} value={action}>
              <bdi>{action}</bdi>
            </MenuItem>
          ))}
        </TextField>
      </Box>
      <Box sx={{ display: 'grid', gap: '6px', minWidth: 160 }}>
        {label(targetId, t('system:auditLog.filters.target'))}
        <TextField
          id={targetId}
          select
          size="small"
          value={filters.targetType}
          onChange={(event) => {
            onChange({ targetType: event.target.value });
          }}
          slotProps={{
            select: { displayEmpty: true },
            htmlInput: { 'aria-label': t('system:auditLog.filters.target') },
          }}
        >
          <MenuItem value="">{t('system:auditLog.filters.anyTarget')}</MenuItem>
          {TARGET_OPTIONS.map((target) => (
            <MenuItem key={target} value={target}>
              {t(`system:auditLog.targets.${target}`)}
            </MenuItem>
          ))}
        </TextField>
      </Box>
      <Box sx={{ display: 'grid', gap: '6px', minWidth: 160 }}>
        {label(brandId, t('system:auditLog.filters.brand'))}
        <TextField
          id={brandId}
          select
          size="small"
          value={filters.brand}
          onChange={(event) => {
            onChange({ brand: event.target.value });
          }}
          slotProps={{
            select: { displayEmpty: true },
            htmlInput: { 'aria-label': t('system:auditLog.filters.brand') },
          }}
        >
          <MenuItem value="">{t('system:auditLog.filters.allBrands')}</MenuItem>
          <MenuItem value="install">{t('system:auditLog.install')}</MenuItem>
          {brands.map((brand) => (
            <MenuItem key={brand.id} value={brand.id}>
              {brand.name}
            </MenuItem>
          ))}
        </TextField>
      </Box>
      <Box
        component="fieldset"
        sx={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: '6px' }}
      >
        <Typography component="legend" sx={{ fontSize: 13, fontWeight: 500, padding: 0 }}>
          {t('system:auditLog.filters.range')}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <TextField
            size="small"
            type="date"
            value={filters.from}
            onChange={(event) => {
              onChange({ from: event.target.value });
            }}
            slotProps={{ htmlInput: { 'aria-label': t('system:auditLog.filters.from') } }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('system:auditLog.filters.to')}
          </Typography>
          <TextField
            size="small"
            type="date"
            value={filters.to}
            onChange={(event) => {
              onChange({ to: event.target.value });
            }}
            slotProps={{ htmlInput: { 'aria-label': t('system:auditLog.filters.toLabel') } }}
          />
        </Box>
      </Box>
      <Button
        variant="text"
        disabled={!hasFilters(filters)}
        onClick={() => {
          onChange(NO_FILTERS);
        }}
      >
        {t('system:auditLog.filters.clear')}
      </Button>
    </Paper>
  );
}

function Entries({
  page,
  open,
  onToggle,
  newer,
  older,
}: {
  readonly page: AuditPage;
  readonly open: ReadonlySet<string>;
  onToggle(id: string): void;
  newer: (() => void) | null;
  older: (() => void) | null;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const columns = 7;

  return (
    <Box component="section" aria-label={t('system:auditLog.entries')}>
      <TableContainer
        sx={{
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
        }}
      >
        <Table size="small" aria-label={t('system:auditLog.entries')}>
          <TableHead>
            <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
              <TableCell>
                <Box component="span" sx={visuallyHidden}>
                  {t('system:auditLog.columns.details')}
                </Box>
              </TableCell>
              <TableCell>{t('system:auditLog.columns.time', { zone: utcOffsetLabel() })}</TableCell>
              <TableCell>{t('system:auditLog.columns.actor')}</TableCell>
              <TableCell>{t('system:auditLog.columns.action')}</TableCell>
              <TableCell>{t('system:auditLog.columns.target')}</TableCell>
              <TableCell>{t('system:auditLog.columns.brand')}</TableCell>
              <TableCell>{t('system:auditLog.columns.ip')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {page.entries.map((entry) => (
              <EntryRows
                key={entry.id}
                entry={entry}
                expanded={open.has(entry.id)}
                columns={columns}
                onToggle={() => {
                  onToggle(entry.id);
                }}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, marginBlockStart: 3 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1 }}>
          {t('system:auditLog.perPage', { shown: page.entries.length })}
        </Typography>
        <Button
          variant="outlined"
          size="small"
          disabled={newer === null}
          onClick={newer ?? undefined}
        >
          {t('system:auditLog.newer')}
        </Button>
        <Button
          variant="outlined"
          size="small"
          disabled={older === null}
          onClick={older ?? undefined}
        >
          {t('system:auditLog.older')}
        </Button>
      </Box>
    </Box>
  );
}

function EntryRows({
  entry,
  expanded,
  columns,
  onToggle,
}: {
  readonly entry: AuditRecord;
  readonly expanded: boolean;
  readonly columns: number;
  onToggle(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const regionId = useId();
  const stamp = auditStamp(entry.createdAt);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <>
      <TableRow sx={{ height: 44 }}>
        <TableCell sx={{ width: 40 }}>
          <IconButton
            size="small"
            aria-expanded={expanded}
            aria-controls={regionId}
            aria-label={t('system:auditLog.expand', { action: entry.action, time: stamp })}
            onClick={onToggle}
          >
            {/* Directional, so mirrored in RTL (DESIGN §5). */}
            <Box
              component="span"
              sx={{ display: 'inline-flex', '[dir="rtl"] &': { transform: 'scaleX(-1)' } }}
            >
              <Chevron size={16} aria-hidden="true" />
            </Box>
          </IconButton>
        </TableCell>
        <TableCell
          sx={{ fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 12, whiteSpace: 'nowrap' }}
        >
          <bdi>{stamp}</bdi>
        </TableCell>
        <TableCell>
          <Actor entry={entry} />
        </TableCell>
        <TableCell sx={{ fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 12 }}>
          <bdi>{entry.action}</bdi>
        </TableCell>
        <TableCell>
          <bdi>{targetLabel(entry, t)}</bdi>
        </TableCell>
        <TableCell>{entry.brandName ?? t('system:auditLog.install')}</TableCell>
        <TableCell sx={{ fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 12 }}>
          <bdi>{entry.ip ?? '—'}</bdi>
        </TableCell>
      </TableRow>
      {expanded ? (
        <TableRow>
          <TableCell colSpan={columns} sx={{ backgroundColor: tokens['bg.canvas'] }}>
            <Box
              id={regionId}
              role="region"
              aria-label={t('system:auditLog.region', { action: entry.action, time: stamp })}
              sx={{ display: 'grid', gap: 2, paddingBlock: 2 }}
            >
              <Details entry={entry} />
            </Box>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function Actor({ entry }: { readonly entry: AuditRecord }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  if (entry.actorType === 'staff' && entry.actorName !== null) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box
          aria-hidden="true"
          sx={{
            width: 24,
            height: 24,
            borderRadius: '999px',
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            fontWeight: 600,
            backgroundColor: tokens['action.primary.tint'],
            color: tokens['action.primary'],
          }}
        >
          {initialsOf(entry.actorName)}
        </Box>
        {entry.actorName}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Typography
        variant="caption"
        sx={{
          backgroundColor: tokens['bg.muted'],
          color: 'text.secondary',
          borderRadius: '6px',
          paddingInline: 2,
        }}
      >
        {t(`system:auditLog.actorTypes.${entry.actorType}`)}
      </Typography>
      <bdi>{entry.actorName ?? entry.actorId}</bdi>
    </Box>
  );
}

function Details({ entry }: { readonly entry: AuditRecord }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const agent = userAgentSummary(entry.userAgent);

  return (
    <>
      <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <Typography variant="caption">
          {t('system:auditLog.changed', { count: entry.changes.length })}
        </Typography>
        {entry.requestId === null ? null : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('system:auditLog.request')}{' '}
            <Box component="span" sx={{ fontFamily: 'var(--hd-font-mono, monospace)' }}>
              <bdi>{entry.requestId}</bdi>
            </Box>
          </Typography>
        )}
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary' }}
          title={entry.userAgent ?? undefined}
        >
          {agent === null
            ? t(`system:auditLog.via.${entry.actorType}`)
            : t('system:auditLog.viaBrowser', {
                via: t(`system:auditLog.via.${entry.actorType}`),
                browser: agent.browser,
                system: agent.system,
              })}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('system:auditLog.target')}{' '}
          <Box component="span" sx={{ fontFamily: 'var(--hd-font-mono, monospace)' }}>
            <bdi>{`${entry.targetType}/${entry.targetId ?? '—'}`}</bdi>
          </Box>
        </Typography>
      </Box>

      {entry.changes.length === 0 ? null : (
        <Table
          size="small"
          aria-label={t('system:auditLog.region', {
            action: entry.action,
            time: auditStamp(entry.createdAt),
          })}
        >
          <TableHead>
            <TableRow>
              <TableCell component="th" scope="col">
                {t('system:auditLog.diff.field')}
              </TableCell>
              <TableCell component="th" scope="col">
                {t('system:auditLog.diff.before')}
              </TableCell>
              <TableCell component="th" scope="col">
                {t('system:auditLog.diff.after')}
              </TableCell>
              <TableCell component="th" scope="col">
                <Box component="span" sx={visuallyHidden}>
                  {t('system:auditLog.diff.note')}
                </Box>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {entry.changes.map((change) => (
              <TableRow key={change.field}>
                <TableCell
                  component="th"
                  scope="row"
                  sx={{ fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 12 }}
                >
                  <bdi>{change.field}</bdi>
                </TableCell>
                <TableCell>
                  <Value value={change.before} tone={tokens['status.danger.tint']} />
                </TableCell>
                <TableCell>
                  <Value value={change.after} tone={tokens['status.success.tint']} />
                </TableCell>
                <TableCell>
                  {change.secret ? (
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {t('system:auditLog.diff.secret')}
                    </Typography>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {entry.details.length === 0 ? null : (
        <Box
          component="dl"
          sx={{
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            columnGap: 4,
            rowGap: 1,
            margin: 0,
          }}
        >
          {entry.details.map((detail) => (
            <Box key={detail.field} sx={{ display: 'contents' }}>
              <Typography
                component="dt"
                variant="caption"
                sx={{ fontFamily: 'var(--hd-font-mono, monospace)' }}
              >
                <bdi>{detail.field}</bdi>
              </Typography>
              <Typography component="dd" variant="caption" sx={{ margin: 0 }}>
                <bdi>{detail.value ?? '—'}</bdi>
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </>
  );
}

function Value({
  value,
  tone,
}: {
  readonly value: string | null;
  readonly tone: string;
}): ReactNode {
  if (value === null) {
    return <span>—</span>;
  }

  return (
    <Box
      component="span"
      sx={{
        backgroundColor: tone,
        borderRadius: '4px',
        paddingInline: 1,
        fontFamily: 'var(--hd-font-mono, monospace)',
        fontSize: 12,
        wordBreak: 'break-all',
      }}
    >
      <bdi>{value}</bdi>
    </Box>
  );
}

const targetLabel = (entry: AuditRecord, t: ReturnType<typeof useT>): string => {
  const known = (TARGET_OPTIONS as readonly string[]).includes(entry.targetType);
  const kind = known
    ? t(`system:auditLog.targets.${entry.targetType as (typeof TARGET_OPTIONS)[number]}`)
    : entry.targetType;

  return entry.targetId === null ? kind : `${kind} · ${entry.targetId}`;
};
