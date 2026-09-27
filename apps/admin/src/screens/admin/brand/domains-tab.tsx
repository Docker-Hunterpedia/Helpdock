import type { CustomDomain, CustomDomainUpdateRequest, DnsRecord } from '@helpdock/schemas';
import { MAX_HELPCENTER_DOMAINS } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  IconButton,
  Link as MuiLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Cloud, Copy, Globe, Plus, RefreshCw, Star, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { channelsRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useSession } from '../../../auth/session.tsx';
import { isDomainsError } from '../../../domains/api.js';
import { useDomainsApi } from '../../../domains/context.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { ActionsMenu, type MenuAction } from '../../../ui/actions-menu.tsx';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { ago, clockTime, shortDate } from '../channels/format.js';

/**
 * Brand › Domains (M5-07), the `AdminBrandDomains` artboard: the brand's
 * custom help center domains, the two DNS records each one needs, what the
 * last check saw, and the Cloudflare flag. The check itself runs in the worker;
 * this screen asks for one and reads the result back.
 *
 * Widget origins are not here: they live on Channels › Widget, which the aside
 * links to.
 */

/** A pending or failing domain is looked at again this often while the tab is open. */
const REFRESH_MS = 30_000;

const queryKey = (brandId: string) => ['domains', brandId] as const;

export function DomainsTab(): ReactNode {
  const t = useT();
  const api = useDomainsApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [removing, setRemoving] = useState<CustomDomain | null>(null);

  const domains = useQuery({
    queryKey: queryKey(brand.id),
    queryFn: () => api.domains(brand.id),
    refetchInterval: (query) =>
      query.state.data?.domains.some((domain) => domain.state !== 'verified') === true
        ? REFRESH_MS
        : false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKey(brand.id) });
  const failed = () => {
    toast({ tone: 'danger', message: t('brand:domains.toast.failed') });
  };

  const check = useMutation({
    mutationFn: (domain: CustomDomain) => api.checkDomain(brand.id, domain.id),
    onSuccess: async (domain) => {
      await refresh();
      toast({
        tone: 'success',
        message: t('brand:domains.toast.checking', { domain: domain.domain }),
      });
    },
    onError: failed,
  });

  const update = useMutation({
    mutationFn: ({
      domain,
      request,
    }: {
      readonly domain: CustomDomain;
      readonly request: CustomDomainUpdateRequest;
    }) => api.updateDomain(brand.id, domain.id, request),
    onSuccess: async (domain, { request }) => {
      await refresh();
      toast({
        tone: 'success',
        message: t(
          request.primary === true ? 'brand:domains.toast.primary' : 'brand:domains.toast.proxied',
          {
            domain: domain.domain,
          },
        ),
      });
    },
    onError: failed,
  });

  const remove = useMutation({
    mutationFn: (domain: CustomDomain) => api.removeDomain(brand.id, domain.id),
    onSuccess: async (_result, domain) => {
      setRemoving(null);
      await refresh();
      toast({
        tone: 'success',
        message: t('brand:domains.toast.removed', { domain: domain.domain }),
      });
    },
    onError: failed,
  });

  const rows = domains.data?.domains ?? [];

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 300px' },
        gap: 8,
        alignContent: 'start',
      }}
    >
      <Box
        component="section"
        aria-labelledby={headingId}
        sx={{
          alignSelf: 'start',
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        }}
      >
        <Box
          sx={{
            paddingBlock: 4,
            paddingInline: 5,
            borderBlockEnd: `1px solid ${tokens['bg.muted']}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
            {t('brand:domains.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
            {t('brand:domains.lead')}
          </Typography>
        </Box>

        <AddDomainForm brandId={brand.id} onAdded={refresh} />

        {domains.isError ? (
          <Box sx={{ paddingInline: 5, paddingBlockEnd: 4 }}>
            <AlertBanner tone="danger">{t('brand:domains.loadFailed')}</AlertBanner>
          </Box>
        ) : null}

        {rows.length === 0 && domains.isSuccess ? (
          <Box sx={{ padding: 6, borderBlockStart: `1px solid ${tokens['bg.muted']}` }}>
            <EmptyState
              icon={Globe}
              heading={t('brand:domains.empty.heading')}
              body={t('brand:domains.empty.body')}
            />
          </Box>
        ) : (
          <Box
            component="ul"
            aria-label={t('brand:domains.listLabel')}
            sx={{
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {rows.map((domain) => (
              <DomainItem
                key={domain.id}
                domain={domain}
                busy={check.isPending || update.isPending}
                onCheck={() => {
                  check.mutate(domain);
                }}
                onUpdate={(request) => {
                  update.mutate({ domain, request });
                }}
                onRemove={() => {
                  setRemoving(domain);
                }}
              />
            ))}
          </Box>
        )}
      </Box>

      <DomainsAside />

      <ConfirmDialog
        open={removing !== null}
        title={t('brand:domains.removeConfirm.title', { domain: removing?.domain ?? '' })}
        body={t('brand:domains.removeConfirm.body')}
        confirmLabel={t('brand:domains.removeConfirm.action')}
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

function AddDomainForm({
  brandId,
  onAdded,
}: {
  readonly brandId: string;
  onAdded(): Promise<void>;
}): ReactNode {
  const t = useT();
  const api = useDomainsApi();
  const toast = useToast();
  const id = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const hint = t('brand:domains.add.hint');

  const add = useMutation({
    mutationFn: (domain: string) => api.addDomain(brandId, domain),
    onSuccess: async (domain) => {
      setValue('');
      setError(undefined);
      await onAdded();
      toast({
        tone: 'success',
        message: t('brand:domains.toast.added', { domain: domain.domain }),
      });
    },
    onError: (failure) => {
      if (isDomainsError(failure)) {
        setError(t(`brand:domains.refusals.${failure.reason}`, { max: MAX_HELPCENTER_DOMAINS }));
        return;
      }
      toast({ tone: 'danger', message: t('brand:domains.toast.failed') });
    },
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (value.trim() === '') {
      setError(t('brand:domains.refusals.domain-invalid'));
      return;
    }
    add.mutate(value);
  };

  return (
    <Box
      component="form"
      noValidate
      onSubmit={submit}
      sx={{ paddingBlock: 4, paddingInline: 5, maxWidth: 600 }}
    >
      <Field id={id} label={t('brand:domains.add.label')} hint={hint} error={error}>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField
            id={id}
            size="small"
            value={value}
            error={error !== undefined}
            placeholder={t('brand:domains.add.placeholder')}
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
            }}
            slotProps={{
              htmlInput: {
                dir: 'ltr',
                spellCheck: false,
                autoCapitalize: 'none',
                maxLength: 253,
                'aria-invalid': error !== undefined,
                'aria-describedby': fieldDescribedBy(id, { hint, error }),
                style: { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 },
              },
            }}
            sx={{ flexGrow: 1, minWidth: 0 }}
          />
          <Button
            type="submit"
            variant="contained"
            startIcon={<Plus size={16} aria-hidden="true" />}
            disabled={add.isPending}
            sx={{ flexShrink: 0 }}
          >
            {t('brand:domains.add.action')}
          </Button>
        </Box>
      </Field>
    </Box>
  );
}

type Tone = 'success' | 'warning' | 'danger';

const toneOf = (domain: CustomDomain): Tone =>
  domain.state === 'verified' ? 'success' : domain.state === 'pending' ? 'warning' : 'danger';

function DomainItem({
  domain,
  busy,
  onCheck,
  onUpdate,
  onRemove,
}: {
  readonly domain: CustomDomain;
  readonly busy: boolean;
  onCheck(): void;
  onUpdate(request: CustomDomainUpdateRequest): void;
  onRemove(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const tone = toneOf(domain);
  const verifiedAndHealthy = domain.state === 'verified';
  const showRecords = domain.verifiedAt === null;

  const actions: MenuAction[] = [
    ...(domain.state === 'verified' && !domain.primary
      ? [
          {
            id: 'primary',
            label: t('brand:domains.makePrimary'),
            icon: Star,
            onSelect: () => {
              onUpdate({ primary: true });
            },
          },
        ]
      : []),
    ...(verifiedAndHealthy
      ? [
          {
            id: 'proxy',
            label: t(domain.cloudflareProxied ? 'brand:domains.proxyOff' : 'brand:domains.proxyOn'),
            icon: Cloud,
            onSelect: () => {
              onUpdate({ cloudflareProxied: !domain.cloudflareProxied });
            },
          },
        ]
      : []),
    {
      id: 'remove',
      label: t('brand:domains.remove'),
      icon: Trash2,
      tone: 'danger',
      dividerBefore: true,
      onSelect: onRemove,
    },
  ];

  return (
    <Box
      component="li"
      sx={{
        paddingInline: 5,
        paddingBlockEnd: verifiedAndHealthy ? 0 : 4,
        borderBlockStart: `1px solid ${tokens['bg.muted']}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <Box
        sx={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: 52, flexWrap: 'wrap' }}
      >
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            width: 8,
            height: 8,
            borderRadius: '999px',
            flexShrink: 0,
            backgroundColor: tokens[`status.${tone}`],
          }}
        />
        <Typography
          component="span"
          variant="mono"
          sx={{ fontSize: 14, fontWeight: 500, overflowWrap: 'anywhere' }}
        >
          <bdi>{domain.domain}</bdi>
        </Typography>
        {domain.primary ? (
          <Box
            component="span"
            sx={{
              height: 20,
              paddingInline: '6px',
              borderRadius: '6px',
              backgroundColor: tokens['bg.muted'],
              color: 'text.secondary',
              fontSize: 12,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {t('brand:domains.primary')}
          </Box>
        ) : null}
        <StateLine domain={domain} tone={tone} />
        <Box sx={{ marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
          {verifiedAndHealthy ? null : (
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              disabled={busy}
              startIcon={<RefreshCw size={14} aria-hidden="true" />}
              onClick={onCheck}
              aria-label={`${t(domain.state === 'failed' ? 'brand:domains.tryAgain' : 'brand:domains.checkNow')} ${domain.domain}`}
            >
              {t(domain.state === 'failed' ? 'brand:domains.tryAgain' : 'brand:domains.checkNow')}
            </Button>
          )}
          <ActionsMenu
            label={t('brand:domains.actionsFor', { domain: domain.domain })}
            menuLabel={t('brand:domains.actionsFor', { domain: domain.domain })}
            items={actions}
          />
        </Box>
      </Box>

      {domain.failure === null ? null : <FailureNotice domain={domain} />}
      {showRecords ? <DnsRecords domain={domain} /> : null}
      {verifiedAndHealthy ? null : (
        <CloudflareFlag
          domain={domain}
          disabled={busy}
          onChange={(cloudflareProxied) => {
            onUpdate({ cloudflareProxied });
          }}
        />
      )}
      {domain.state === 'pending' ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('brand:domains.dnsDelay')}
        </Typography>
      ) : null}
    </Box>
  );
}

function StateLine({
  domain,
  tone,
}: {
  readonly domain: CustomDomain;
  readonly tone: Tone;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();

  let text: string;
  if (domain.state === 'failed' && domain.failure !== null) {
    text = t(`brand:domains.state.failed.${domain.failure.reason}`);
  } else if (domain.state === 'verified') {
    text =
      domain.tls === 'cloudflare'
        ? t('brand:domains.state.cloudflare')
        : domain.tls === 'issued' && domain.tlsIssuedAt !== null
          ? t('brand:domains.state.issued', { date: shortDate(domain.tlsIssuedAt, locale) })
          : t('brand:domains.state.tlsPending');
  } else {
    text =
      domain.lastCheckedAt === null
        ? t('brand:domains.state.pendingNever')
        : t('brand:domains.state.pending', { ago: ago(domain.lastCheckedAt, Date.now(), locale) });
  }

  return (
    <Typography component="span" sx={{ fontSize: 13, color: tokens[`status.${tone}.text`] }}>
      {text}
    </Typography>
  );
}

function FailureNotice({ domain }: { readonly domain: CustomDomain }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  if (domain.failure === null) {
    return null;
  }

  return (
    <AlertBanner tone="danger">
      {t(`brand:domains.failure.${domain.failure.reason}`, {
        detail: domain.failure.detail ?? '',
        target: domain.records.cname.value,
      })}
      {domain.lastCheckedAt === null
        ? null
        : ` ${t('brand:domains.failure.lastTry', { time: clockTime(domain.lastCheckedAt, locale) })}`}
    </AlertBanner>
  );
}

function DnsRecords({ domain }: { readonly domain: CustomDomain }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const records = [domain.records.cname, domain.records.txt];
  const headSx = { fontSize: 12, fontWeight: 500, color: 'text.secondary', paddingBlock: 0 };

  return (
    <Box
      sx={{
        borderRadius: '10px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
        overflow: 'hidden',
      }}
    >
      <Typography sx={{ paddingBlock: '10px', paddingInline: 3, fontSize: 13, fontWeight: 500 }}>
        {t('brand:domains.records.heading')}
      </Typography>
      <TableContainer sx={{ backgroundColor: tokens['bg.surface'] }}>
        <Table
          size="small"
          aria-label={t('brand:domains.records.tableLabel', { domain: domain.domain })}
          sx={{ tableLayout: 'fixed', minWidth: 560 }}
        >
          <TableHead>
            <TableRow sx={{ height: 32, backgroundColor: tokens['bg.muted'] }}>
              <TableCell sx={{ ...headSx, width: 76 }}>
                {t('brand:domains.records.columns.type')}
              </TableCell>
              <TableCell sx={headSx}>{t('brand:domains.records.columns.name')}</TableCell>
              <TableCell sx={{ ...headSx, width: '42%' }}>
                {t('brand:domains.records.columns.value')}
              </TableCell>
              <TableCell sx={{ ...headSx, width: 132 }}>
                {t('brand:domains.records.columns.seen')}
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {records.map((record) => (
              <RecordRow key={record.type} record={record} />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

function RecordRow({ record }: { readonly record: DnsRecord }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <TableRow sx={{ height: 40 }}>
      <TableCell
        sx={{ fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 12, fontWeight: 500 }}
      >
        {record.type}
      </TableCell>
      <TableCell>
        <CopyValue
          text={record.name}
          label={t('brand:domains.records.copyName', { type: record.type })}
        />
      </TableCell>
      <TableCell>
        <CopyValue
          text={record.value}
          label={t('brand:domains.records.copyValue', { type: record.type })}
        />
      </TableCell>
      <TableCell sx={{ fontSize: 12 }}>
        <Box
          component="span"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 1,
            color: tokens[record.seen ? 'status.success.text' : 'status.warning.text'],
          }}
        >
          {record.seen ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Clock size={14} aria-hidden="true" />
          )}
          {t(record.seen ? 'brand:domains.records.found' : 'brand:domains.records.notYet')}
        </Box>
      </TableCell>
    </TableRow>
  );
}

function CopyValue({ text, label }: { readonly text: string; readonly label: string }): ReactNode {
  const t = useT();
  const toast = useToast();
  const tokens = useSemanticTokens();

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: 'success', message: t('brand:domains.records.copied') });
    } catch {
      toast({ tone: 'danger', message: t('brand:domains.toast.failed') });
    }
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
      <Typography
        component="span"
        variant="mono"
        dir="ltr"
        title={text}
        sx={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {text}
      </Typography>
      <IconButton
        size="small"
        aria-label={label}
        onClick={() => {
          void copy();
        }}
        sx={{
          width: 28,
          height: 28,
          flexShrink: 0,
          border: `1px solid ${tokens['border.strong']}`,
          borderRadius: '6px',
        }}
      >
        <Copy size={14} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}

function CloudflareFlag({
  domain,
  disabled,
  onChange,
}: {
  readonly domain: CustomDomain;
  readonly disabled: boolean;
  onChange(value: boolean): void;
}): ReactNode {
  const t = useT();
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3 }}>
      <Checkbox
        id={id}
        checked={domain.cloudflareProxied}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        slotProps={{ input: { 'aria-describedby': hintId } }}
        sx={{ padding: 0, marginBlockStart: '2px' }}
      />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <Typography component="label" htmlFor={id} sx={{ fontWeight: 500, fontSize: 14 }}>
          {t('brand:domains.cloudflare.label')}
        </Typography>
        <Typography id={hintId} variant="caption" sx={{ color: 'text.secondary', fontSize: 13 }}>
          {t('brand:domains.cloudflare.hint')}
        </Typography>
      </Box>
    </Box>
  );
}

function DomainsAside(): ReactNode {
  const t = useT();

  return (
    <Box
      component="aside"
      aria-label={t('brand:domains.aside.label')}
      sx={{ display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'start' }}
    >
      <AsideCard heading={t('brand:domains.aside.howHeading')}>
        <Box
          component="ol"
          sx={{
            margin: 0,
            paddingInlineStart: '18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <li>{t('brand:domains.aside.how1')}</li>
          <li>{t('brand:domains.aside.how2')}</li>
          <li>{t('brand:domains.aside.how3')}</li>
          <li>{t('brand:domains.aside.how4')}</li>
        </Box>
      </AsideCard>
      <AsideCard heading={t('brand:domains.aside.statesHeading')}>
        <StateKey tone="success" text={t('brand:domains.aside.stateVerified')} />
        <StateKey tone="warning" text={t('brand:domains.aside.statePending')} />
        <StateKey tone="danger" text={t('brand:domains.aside.stateFailed')} />
      </AsideCard>
      <AsideCard heading={t('brand:domains.aside.widgetHeading')}>
        <span>
          {t('brand:domains.aside.widgetBefore')}{' '}
          <MuiLink component={Link} to={channelsRoute('widget')}>
            {t('brand:domains.aside.widgetLink')}
          </MuiLink>
          {t('brand:domains.aside.widgetAfter')}
        </span>
      </AsideCard>
      <AsideCard heading={t('brand:domains.aside.whoHeading')}>
        <span>{t('brand:domains.aside.whoBody')}</span>
      </AsideCard>
    </Box>
  );
}

function AsideCard({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box
      sx={{
        paddingBlock: '14px',
        paddingInline: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontSize: 13,
        lineHeight: '18px',
        color: 'text.secondary',
      }}
    >
      <Typography component="h3" sx={{ fontSize: 13, fontWeight: 600, color: 'text.primary' }}>
        {heading}
      </Typography>
      {children}
    </Box>
  );
}

function StateKey({ tone, text }: { readonly tone: Tone; readonly text: string }): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Box
        component="span"
        aria-hidden="true"
        sx={{
          width: 8,
          height: 8,
          borderRadius: '999px',
          flexShrink: 0,
          backgroundColor: tokens[`status.${tone}`],
        }}
      />
      {text}
    </Box>
  );
}
