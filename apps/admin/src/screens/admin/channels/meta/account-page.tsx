import {
  META_TOKEN_MIN_LENGTH,
  type MetaAccount,
  type MetaAccountStatusResponse,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Link as MuiLink,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Network, Unplug } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { channelsRoute, ROUTES } from '../../../../app/route-paths.js';
import { useSemanticTokens } from '../../../../app/tokens.js';
import { currentBrand, useSession, useTicketingApi } from '../../../../auth/session.tsx';
import { isMetaError, metaKeys } from '../../../../meta/api.js';
import { useMetaApi } from '../../../../meta/context.tsx';
import { EmptyState } from '../../../../shell/empty-state.tsx';
import { useToast } from '../../../../ui/toasts.tsx';
import { clockTime, shortDate } from '../format.js';
import { Card } from '../telegram/form-section.tsx';
import {
  type AccountDraft,
  type AccountDraftErrors,
  draftFromAccount,
  isDraftDirty,
  validateDraft,
} from './account-draft.js';
import { AccountHealth } from './account-health.tsx';
import { ConnectionSection } from './connection-section.tsx';
import { DisconnectDialog } from './disconnect-dialog.tsx';
import { HumanAgentSection } from './human-agent-section.tsx';
import { NumberSection } from './number-section.tsx';
import { accountLabel, PLATFORM_ICONS } from './platforms.js';
import { ReconnectDialog } from './reconnect-dialog.tsx';
import { RoutingSection } from './routing-section.tsx';
import { SubscriptionSection } from './subscription-section.tsx';

/**
 * One account (M10-07, M10-10; `Admin/Channels-Meta-Account`): its form —
 * Connection, Subscription, Number (WhatsApp), Routing and Human Agent
 * (Messenger and Instagram), saved together — beside the Activity card and the
 * Disconnect card. Reconnect is a dialog over it.
 */
export function MetaAccountPage({ accountId }: { readonly accountId: string }): ReactNode {
  const t = useT();
  const api = useMetaApi();
  const ticketing = useTicketingApi();
  const brand = currentBrand(useSession());

  const account = useQuery({
    queryKey: metaKeys.account(brand.id, accountId),
    queryFn: () => api.account(brand.id, accountId),
  });
  const status = useQuery({
    queryKey: metaKeys.status(brand.id, accountId),
    queryFn: () => api.status(brand.id, accountId),
  });
  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => ticketing.departments(brand.id),
  });

  if (account.isError) {
    return (
      <EmptyState
        icon={Network}
        heading={t('channels:meta.detail.notFound.heading')}
        body={t('channels:meta.detail.notFound.body')}
        action={
          <Button variant="outlined" component={Link} to={channelsRoute('meta')}>
            {t('channels:meta.detail.back')}
          </Button>
        }
      />
    );
  }
  if (account.data === undefined || departments.data === undefined) {
    return <CircularProgress aria-label={t('channels:meta.heading')} />;
  }

  return (
    <AccountForm
      key={account.data.id}
      account={account.data}
      status={status.data}
      departments={departments.data.departments}
    />
  );
}

interface DepartmentOption {
  readonly id: string;
  readonly name: string;
  readonly nameAr: string | null;
}

function AccountForm({
  account,
  status,
  departments,
}: {
  readonly account: MetaAccount;
  readonly status: MetaAccountStatusResponse | undefined;
  readonly departments: readonly DepartmentOption[];
}): ReactNode {
  const t = useT();
  const api = useMetaApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();

  const saved = useMemo(() => draftFromAccount(account), [account]);
  const [draft, setDraft] = useState<AccountDraft>(saved);
  const [errors, setErrors] = useState<AccountDraftErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [now] = useState(Date.now);

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const change = <K extends keyof AccountDraft>(key: K, value: AccountDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setRefusal(null);
  };

  const save = useMutation({
    mutationFn: async () => {
      const checked = validateDraft(draft, account);
      if (!checked.ok) {
        setErrors(checked.errors);
        return undefined;
      }
      return api.updateAccount(brand.id, account.id, checked.request);
    },
    onSuccess: async (result) => {
      if (result === undefined) {
        return;
      }
      queryClient.setQueryData(metaKeys.account(brand.id, account.id), result);
      await queryClient.invalidateQueries({ queryKey: metaKeys.accounts(brand.id) });
      await queryClient.invalidateQueries({ queryKey: metaKeys.status(brand.id, account.id) });
      toast({
        tone: 'success',
        message: t('channels:meta.toast.saved', { name: accountLabel(result) }),
      });
    },
    onError: (error: unknown) => {
      if (isMetaError(error)) {
        setRefusal(t(`channels:meta.refusal.${error.reason}`));
        return;
      }
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const dirty = isDraftDirty(draft, saved);
  const name = accountLabel(account);
  const Icon = PLATFORM_ICONS[account.platform];
  const checkedAt = status?.subscriptionCheckedAt ?? null;

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 320px' },
        gap: 6,
        alignItems: 'start',
      }}
    >
      <Card>
        <Box
          component="form"
          noValidate
          aria-label={name}
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Box
            component="header"
            sx={{ padding: 5, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}
          >
            <IconButton
              component={Link}
              to={channelsRoute('meta')}
              aria-label={t('channels:meta.detail.back')}
              size="small"
            >
              <ArrowLeft size={16} aria-hidden="true" className="mirror-in-rtl" />
            </IconButton>
            <Box
              aria-hidden="true"
              sx={{
                width: 40,
                height: 40,
                borderRadius: '6px',
                display: 'grid',
                placeItems: 'center',
                backgroundColor: tokens['bg.muted'],
              }}
            >
              <Icon size={16} />
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Typography variant="h2">
                <bdi>{name}</bdi>
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                <bdi>
                  {t(`channels:meta.detail.caption.${account.platform}`, {
                    name: account.displayName,
                    id: account.externalId,
                    date: shortDate(account.createdAt, locale),
                  })}
                </bdi>
              </Typography>
            </Box>
            <Box sx={{ marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
              <AccountHealth account={account} now={now} />
              {checkedAt === null ? null : (
                <Typography variant="mono" component="span" sx={{ color: 'text.secondary' }}>
                  {t('channels:meta.detail.checked', { time: clockTime(checkedAt, locale) })}
                </Typography>
              )}
            </Box>
          </Box>

          <ConnectionSection
            account={account}
            status={status}
            token={draft.token}
            tokenError={
              errors.token === undefined
                ? undefined
                : t('channels:meta.connect.malformedToken', { min: META_TOKEN_MIN_LENGTH })
            }
            onTokenChange={(token) => {
              change('token', token);
            }}
            onReconnect={() => {
              setReconnecting(true);
            }}
          />

          <SubscriptionSection account={account} status={status} />

          {account.platform === 'whatsapp' ? <NumberSection account={account} /> : null}

          <RoutingSection
            platform={account.platform}
            departments={departments}
            departmentId={draft.departmentId}
            onChange={(departmentId) => {
              change('departmentId', departmentId);
            }}
          />

          {account.platform === 'whatsapp' ? null : (
            <HumanAgentSection
              enabled={draft.humanAgentEnabled}
              onChange={(enabled) => {
                change('humanAgentEnabled', enabled);
              }}
            />
          )}

          <Box
            sx={{
              paddingBlock: 3,
              paddingInline: 5,
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              flexWrap: 'wrap',
              borderBlockStart: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.canvas'],
              borderEndStartRadius: '10px',
              borderEndEndRadius: '10px',
            }}
          >
            {refusal === null ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }} aria-live="polite">
                {dirty
                  ? t('channels:meta.detail.footer.unsaved')
                  : t(
                      account.platform === 'whatsapp'
                        ? 'channels:meta.detail.footer.noteWhatsapp'
                        : 'channels:meta.detail.footer.note',
                    )}
              </Typography>
            ) : (
              <Typography
                variant="caption"
                role="alert"
                sx={{ color: tokens['status.danger.text'] }}
              >
                {refusal}
              </Typography>
            )}
            <Button
              variant="text"
              sx={{ marginInlineStart: 'auto' }}
              disabled={!dirty}
              onClick={() => {
                setDraft(saved);
                setErrors({});
                setRefusal(null);
              }}
            >
              {t('channels:meta.detail.footer.discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={!dirty || save.isPending}>
              {t('channels:meta.detail.footer.save')}
            </Button>
          </Box>
        </Box>
      </Card>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ActivityCard account={account} status={status} />
        <Card label={t('channels:meta.detail.danger.heading')} tone="danger">
          <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Typography variant="h3" component="h2" sx={{ color: tokens['status.danger.text'] }}>
              {t('channels:meta.detail.danger.heading')}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t(`channels:meta.detail.danger.body.${account.platform}`)}
            </Typography>
            <Button
              variant="outlined"
              color="error"
              aria-haspopup="dialog"
              startIcon={<Unplug size={16} aria-hidden="true" />}
              sx={{ alignSelf: 'flex-start' }}
              onClick={() => {
                setDisconnecting(true);
              }}
            >
              {t('channels:meta.detail.danger.action')}
            </Button>
          </Box>
        </Card>
      </Box>

      <ReconnectDialog
        account={account}
        open={reconnecting}
        onClose={() => {
          setReconnecting(false);
        }}
      />
      <DisconnectDialog
        account={disconnecting ? account : null}
        onClose={() => {
          setDisconnecting(false);
        }}
        onDisconnected={() => {
          void navigate(channelsRoute('meta'));
        }}
      />
    </Box>
  );
}

function ActivityCard({
  account,
  status,
}: {
  readonly account: MetaAccount;
  readonly status: MetaAccountStatusResponse | undefined;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const none = t('channels:meta.detail.activity.none');
  const time = (iso: string | null | undefined): string =>
    iso == null ? none : clockTime(iso, locale);
  const rows: readonly (readonly [string, string])[] = [
    [t('channels:meta.detail.activity.lastEvent'), time(account.lastEventAt)],
    [t('channels:meta.detail.activity.lastReply'), time(status?.activity.lastReplyAt)],
    [
      t('channels:meta.detail.activity.failed'),
      status === undefined ? none : String(status.activity.failedSends),
    ],
    [
      t('channels:meta.detail.activity.refused'),
      status === undefined ? none : String(status.activity.refusedSends),
    ],
    [
      t(`channels:meta.detail.activity.open.${account.platform}`),
      status === undefined ? none : String(status.activity.openTickets),
    ],
  ];

  return (
    <Card label={t('channels:meta.detail.activity.heading')}>
      <Box sx={{ padding: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Typography variant="h3" component="h2">
          {t('channels:meta.detail.activity.heading')}
        </Typography>
        <Box
          component="dl"
          sx={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) max-content',
            rowGap: 2,
            columnGap: 4,
            typography: 'body2',
            '& dt': { color: 'text.secondary' },
            '& dd': { margin: 0 },
          }}
        >
          {rows.map(([label, value]) => (
            <Box key={label} sx={{ display: 'contents' }}>
              <dt>{label}</dt>
              <dd>
                <Typography variant="mono" component="span">
                  {value}
                </Typography>
              </dd>
            </Box>
          ))}
        </Box>
        <MuiLink component={Link} to={ROUTES.systemQueues} variant="body2">
          {t('channels:meta.detail.activity.failedJobs')}
        </MuiLink>
      </Box>
    </Card>
  );
}
