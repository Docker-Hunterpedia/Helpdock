import type { ApiKey, ApiKeyCreated } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Link as MuiLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { useDevelopersApi } from '../../../developers/context.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import { Card, CardHeader, headCellSx } from './card.tsx';
import { CreateKeyDialog } from './create-key-dialog.tsx';
import { API_DOCS_PATH } from './developers-page.tsx';
import { curlExample, fullDate, relativeTime } from './format.js';
import { MonoTag, MonoTags } from './mono-tag.tsx';
import { SecretReveal } from './secret-reveal.tsx';

/**
 * Developers › API keys (M8-01, `Admin/Developers-ApiKeys`): the brand's keys
 * with their scopes, rate limit, who issued them and when they were last
 * used; Create, the key shown once, and Revoke behind a confirmation. Revoked
 * keys stay in the list, struck through, when "Show revoked" is ticked.
 */

const queryKey = (brandId: string) => ['developers', 'api-keys', brandId] as const;

export function ApiKeysTab({
  creating,
  onCreate,
  onCreateClose,
}: {
  readonly creating: boolean;
  onCreate(): void;
  onCreateClose(): void;
}): ReactNode {
  const t = useT();
  const api = useDevelopersApi();
  const brand = currentBrand(useSession());
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showRevoked, setShowRevoked] = useState(true);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const headingId = useId();

  const keys = useQuery({ queryKey: queryKey(brand.id), queryFn: () => api.apiKeys(brand.id) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKey(brand.id) });

  const revoke = useMutation({
    mutationFn: (key: ApiKey) => api.revokeApiKey(brand.id, key.id),
    onSuccess: async (key) => {
      setRevoking(null);
      await refresh();
      toast({ tone: 'success', message: t('developers:keys.toast.revoked', { name: key.name }) });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('developers:failed') });
    },
  });

  const all = keys.data?.keys ?? [];
  const active = all.filter((key) => key.revokedAt === null);
  const rows = showRevoked ? all : active;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {keys.isError ? <AlertBanner tone="danger">{t('developers:loadFailed')}</AlertBanner> : null}

      {keys.isSuccess && all.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          heading={t('developers:keys.empty.heading')}
          body={t('developers:keys.empty.body')}
          action={
            <Button
              variant="contained"
              startIcon={<Plus size={16} aria-hidden="true" />}
              onClick={onCreate}
            >
              {t('developers:keys.create')}
            </Button>
          }
        />
      ) : null}

      {all.length > 0 ? (
        <Card labelledBy={headingId}>
          <CardHeader
            headingId={headingId}
            heading={t('developers:keys.heading')}
            caption={t('developers:keys.summary', {
              active: active.length,
              revoked: all.length - active.length,
              brand: brand.name,
            })}
            action={
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={showRevoked}
                    onChange={(event) => {
                      setShowRevoked(event.target.checked);
                    }}
                  />
                }
                label={t('developers:keys.showRevoked')}
                slotProps={{ typography: { sx: { fontSize: 13 } } }}
                sx={{ marginInlineEnd: 0 }}
              />
            }
          />
          <KeysTable
            rows={rows}
            onRevoke={(key) => {
              setRevoking(key);
            }}
          />
        </Card>
      ) : null}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 6,
        }}
      >
        <CurlCard />
        <HowKeysWork />
      </Box>

      <CreateKeyDialog
        open={creating}
        onClose={onCreateClose}
        onCreated={(key) => {
          onCreateClose();
          setCreated(key);
          void refresh();
          toast({
            tone: 'success',
            message: t('developers:keys.toast.created', { name: key.name }),
          });
        }}
      />

      <SecretReveal
        open={created !== null}
        title={t('developers:keys.reveal.title')}
        warningStrong={t('developers:keys.reveal.warningStrong')}
        warning={t('developers:keys.reveal.warning')}
        label={created?.name ?? ''}
        secret={created?.key ?? ''}
        onDone={() => {
          setCreated(null);
        }}
      >
        {created === null ? null : <KeySummary apiKey={created} />}
      </SecretReveal>

      <ConfirmDialog
        open={revoking !== null}
        title={t('developers:keys.revokeConfirm.title', { name: revoking?.name ?? '' })}
        body={t('developers:keys.revokeConfirm.body', { prefix: revoking?.prefix ?? '' })}
        confirmLabel={t('developers:keys.revokeConfirm.action')}
        destructive
        busy={revoke.isPending}
        onConfirm={() => {
          if (revoking !== null) {
            revoke.mutate(revoking);
          }
        }}
        onClose={() => {
          setRevoking(null);
        }}
      >
        {revoking === null ? null : <RevokeContext apiKey={revoking} />}
      </ConfirmDialog>
    </Box>
  );
}

function KeysTable({
  rows,
  onRevoke,
}: {
  readonly rows: readonly ApiKey[];
  onRevoke(key: ApiKey): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const head = headCellSx(tokens);

  return (
    <TableContainer>
      <Table size="small" aria-label={t('developers:keys.tableLabel')} sx={{ minWidth: 900 }}>
        <TableHead>
          <TableRow sx={{ height: 36, backgroundColor: tokens['bg.muted'] }}>
            <TableCell sx={head}>{t('developers:keys.columns.name')}</TableCell>
            <TableCell sx={head}>{t('developers:keys.columns.key')}</TableCell>
            <TableCell sx={head}>{t('developers:keys.columns.scopes')}</TableCell>
            <TableCell sx={{ ...head, textAlign: 'end' }}>
              {t('developers:keys.columns.rateLimit')}
            </TableCell>
            <TableCell sx={head}>{t('developers:keys.columns.createdBy')}</TableCell>
            <TableCell sx={head}>{t('developers:keys.columns.lastUsed')}</TableCell>
            <TableCell sx={head}>
              <Box component="span" sx={visuallyHidden}>
                {t('developers:keys.columns.actions')}
              </Box>
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((key) => (
            <KeyRow key={key.id} apiKey={key} onRevoke={onRevoke} />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function KeyRow({
  apiKey,
  onRevoke,
}: {
  readonly apiKey: ApiKey;
  onRevoke(key: ApiKey): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const revoked = apiKey.revokedAt !== null;
  const mono = { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 };
  const caption = { fontSize: 12, color: 'text.secondary', display: 'block', whiteSpace: 'nowrap' };

  return (
    <TableRow sx={{ height: 56, verticalAlign: 'middle' }}>
      <TableCell>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography
            component="span"
            sx={{
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              ...(revoked ? { textDecoration: 'line-through', color: 'text.secondary' } : {}),
            }}
          >
            {apiKey.name}
          </Typography>
          {revoked ? <MonoTag muted>{t('developers:keys.revokedTag')}</MonoTag> : null}
        </Box>
      </TableCell>
      <TableCell sx={{ ...mono, color: revoked ? 'text.secondary' : 'text.primary' }}>
        <bdi dir="ltr">{apiKey.prefix}…</bdi>
      </TableCell>
      <TableCell>
        <MonoTags
          values={apiKey.scopes}
          label={t('developers:keys.columns.scopes')}
          muted={revoked}
        />
      </TableCell>
      <TableCell sx={{ ...mono, textAlign: 'end', whiteSpace: 'nowrap' }}>
        <bdi dir="ltr">{t('developers:keys.perMinute', { limit: apiKey.rateLimitPerMinute })}</bdi>
      </TableCell>
      <TableCell>
        <Typography component="span" sx={{ fontSize: 13, display: 'block', whiteSpace: 'nowrap' }}>
          {apiKey.createdByName ?? t('developers:keys.someone')}
        </Typography>
        <Typography component="span" sx={caption}>
          {fullDate(apiKey.createdAt, locale)}
        </Typography>
      </TableCell>
      <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>
        {revoked && apiKey.revokedAt !== null
          ? apiKey.revokedByName === null
            ? t('developers:keys.revokedOnNobody', { date: fullDate(apiKey.revokedAt, locale) })
            : t('developers:keys.revokedOn', {
                date: fullDate(apiKey.revokedAt, locale),
                name: apiKey.revokedByName,
              })
          : apiKey.lastUsedAt === null
            ? t('developers:keys.neverUsed')
            : relativeTime(apiKey.lastUsedAt, Date.now(), locale)}
      </TableCell>
      <TableCell sx={{ textAlign: 'end' }}>
        {revoked ? null : (
          <Button
            size="small"
            variant="outlined"
            color="error"
            aria-label={t('developers:keys.revokeLabel', { name: apiKey.name })}
            onClick={() => {
              onRevoke(apiKey);
            }}
            sx={{ borderColor: tokens['status.danger'] }}
          >
            {t('developers:keys.revoke')}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function KeySummary({ apiKey }: { readonly apiKey: ApiKeyCreated }): ReactNode {
  const t = useT();
  const row = { display: 'grid', gridTemplateColumns: '88px minmax(0, 1fr)', gap: 3 };
  const label = { fontSize: 13, color: 'text.secondary' };
  const mono = { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 };

  return (
    <Box
      component="dl"
      aria-label={t('developers:keys.reveal.summaryLabel')}
      sx={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <Box sx={row}>
        <Typography component="dt" sx={label}>
          {t('developers:keys.reveal.scopes')}
        </Typography>
        <Box component="dd" sx={{ margin: 0 }}>
          <MonoTags values={apiKey.scopes} />
        </Box>
      </Box>
      <Box sx={row}>
        <Typography component="dt" sx={label}>
          {t('developers:keys.reveal.rateLimit')}
        </Typography>
        <Box component="dd" dir="ltr" sx={{ margin: 0, ...mono }}>
          {t('developers:keys.perMinute', { limit: apiKey.rateLimitPerMinute })}
        </Box>
      </Box>
      <Box sx={row}>
        <Typography component="dt" sx={label}>
          {t('developers:keys.reveal.sendAs')}
        </Typography>
        <Box component="dd" dir="ltr" sx={{ margin: 0, ...mono, overflowWrap: 'anywhere' }}>
          Authorization: Bearer {apiKey.prefix}…
        </Box>
      </Box>
    </Box>
  );
}

function RevokeContext({ apiKey }: { readonly apiKey: ApiKey }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const scopes = apiKey.scopes.join(', ');

  return (
    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
      {apiKey.lastUsedAt === null
        ? t('developers:keys.revokeConfirm.neverUsed', { scopes })
        : t('developers:keys.revokeConfirm.lastUsed', {
            when: relativeTime(apiKey.lastUsedAt, Date.now(), locale),
            scopes,
          })}
    </Typography>
  );
}

function CurlCard(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const headingId = useId();
  const example = curlExample(window.location.origin);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(example);
      toast({ tone: 'success', message: t('developers:copied') });
    } catch {
      toast({ tone: 'danger', message: t('developers:copyFailed') });
    }
  };

  return (
    <Card labelledBy={headingId}>
      <Box sx={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
            {t('developers:keys.curl.heading')}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            aria-label={t('developers:keys.curl.copyLabel')}
            startIcon={<Copy size={14} aria-hidden="true" />}
            onClick={() => {
              void copy();
            }}
          >
            {t('developers:copy')}
          </Button>
        </Box>
        <Box
          component="pre"
          dir="ltr"
          tabIndex={0}
          sx={{
            margin: 0,
            padding: 3,
            borderRadius: '6px',
            backgroundColor: tokens['bg.muted'],
            fontFamily: 'var(--hd-font-mono, monospace)',
            fontSize: 12,
            lineHeight: '20px',
            overflowX: 'auto',
          }}
        >
          {example}
        </Box>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('developers:keys.curl.notePrefix')}{' '}
          <Box component="code" dir="ltr" sx={{ fontFamily: 'var(--hd-font-mono, monospace)' }}>
            Idempotency-Key
          </Box>{' '}
          {t('developers:keys.curl.noteMiddle')}{' '}
          <MuiLink href={API_DOCS_PATH} target="_blank" rel="noopener">
            {t('developers:keys.curl.noteLink')}
          </MuiLink>
          .
        </Typography>
      </Box>
    </Card>
  );
}

function HowKeysWork(): ReactNode {
  const t = useT();
  const headingId = useId();

  return (
    <Card labelledBy={headingId}>
      <Box
        sx={{
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          fontSize: 13,
          color: 'text.secondary',
        }}
      >
        <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
          {t('developers:keys.how.heading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'inherit' }}>
          {t('developers:keys.how.shown')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'inherit' }}>
          {t('developers:keys.how.reach')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'inherit' }}>
          {t('developers:keys.how.auditBefore')}{' '}
          <MuiLink component={Link} to={ROUTES.systemAuditLog}>
            {t('developers:keys.how.auditLink')}
          </MuiLink>
          .
        </Typography>
      </Box>
    </Card>
  );
}
