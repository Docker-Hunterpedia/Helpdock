import type { AccountPortal, PortalVisibility } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
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
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { channelsRoute, contactRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useContactsApi, useSession, useTicketingApi } from '../../auth/session.tsx';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { LoadingSkeleton } from '../../ui/loading-skeleton.tsx';
import { RadioCard } from '../../ui/radio-card.tsx';
import { useToast } from '../../ui/toasts.tsx';
import { DASH } from './format.js';
import {
  type AccountPortalDraft,
  accountDraftChanged,
  accountDraftOf,
  accountRequestOf,
  relativeWhen,
  sharesHistory,
} from './portal-format.js';

/**
 * The "Customer portal" section of the account page (M21-06,
 * `Admin/Account-PortalVisibility`): which tickets a member of the company sees
 * when they sign in to the portal (ADR 0060), and who the company managers are.
 *
 * One form and one Save. The Company manager box is enabled only under
 * Managers (a box that does nothing is disabled rather than hidden, and the
 * note under the table says why) but its ticks are kept and saved under any
 * setting, so choosing Own tickets and back loses nobody. Choosing Managers or
 * All members shows the warning before anything is saved. A Viewer reads it.
 */
export function AccountPortalSection({
  accountId,
  accountName,
}: {
  readonly accountId: string;
  readonly accountName: string;
}): ReactNode {
  const t = useT();
  const api = useContactsApi();
  const ticketing = useTicketingApi();
  const brand = currentBrand(useSession());

  const portal = useQuery({
    queryKey: ['account-portal', brand.id, accountId],
    queryFn: () => api.accountPortal(brand.id, accountId),
  });
  const brandQuery = useQuery({
    queryKey: ['brand', brand.id],
    queryFn: () => ticketing.brand(brand.id),
    staleTime: 60_000,
  });

  if (portal.isError) {
    return (
      <Box component="section" aria-label={t('contacts:portal.account.heading')}>
        <AlertBanner tone="danger">{t('contacts:portal.account.loadFailed')}</AlertBanner>
      </Box>
    );
  }
  if (portal.data === undefined) {
    return <LoadingSkeleton />;
  }

  return (
    <PortalForm
      brandId={brand.id}
      accountId={accountId}
      accountName={accountName}
      stored={portal.data}
      portalOn={brandQuery.data?.settings.portal.enabled ?? null}
    />
  );
}

function PortalForm({
  brandId,
  accountId,
  accountName,
  stored,
  portalOn,
}: {
  readonly brandId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly stored: AccountPortal;
  /** Whether the brand's portal is on; null while that is still loading. */
  readonly portalOn: boolean | null;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const api = useContactsApi();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const canWrite = useSession().user.role !== 'viewer';
  const id = useId();
  const [draft, setDraft] = useState<AccountPortalDraft>(() => accountDraftOf(stored));
  const [failed, setFailed] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    setDraft(accountDraftOf(stored));
  }, [stored]);

  const save = useMutation({
    mutationFn: () => api.saveAccountPortal(brandId, accountId, accountRequestOf(draft)),
    onSuccess: async () => {
      setFailed(false);
      await queryClient.invalidateQueries({ queryKey: ['account-portal', brandId, accountId] });
      toast({
        tone: 'success',
        message: t('contacts:portal.account.saved', { name: accountName }),
      });
    },
    onError: () => {
      setFailed(true);
    },
  });

  const changed = accountDraftChanged(draft, stored);
  const choose = (visibility: PortalVisibility): void => {
    setDraft((held) => ({ ...held, visibility }));
  };
  const tick = (contactId: string, on: boolean): void => {
    setDraft((held) => ({
      ...held,
      managerIds: on
        ? [...held.managerIds, contactId]
        : held.managerIds.filter((candidate) => candidate !== contactId),
    }));
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (changed && canWrite) {
      save.mutate();
    }
  };

  const options: readonly { value: PortalVisibility; title: string; hint: string }[] = [
    {
      value: 'own',
      title: t('contacts:portal.account.own'),
      hint: t('contacts:portal.account.ownHint'),
    },
    {
      value: 'managers',
      title: t('contacts:portal.account.managers'),
      hint: t('contacts:portal.account.managersHint', { name: accountName }),
    },
    {
      value: 'all',
      title: t('contacts:portal.account.all'),
      hint: t('contacts:portal.account.allHint', { name: accountName }),
    },
  ];
  const managersOnly = draft.visibility === 'managers';

  return (
    <Box
      component="section"
      aria-labelledby={`${id}-heading`}
      sx={{ display: 'flex', flexDirection: 'column', gap: 4, marginBlockStart: 8 }}
    >
      <Box>
        <Typography id={`${id}-heading`} variant="h3" component="h2">
          {t('contacts:portal.account.heading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('contacts:portal.account.caption', { name: accountName })}
        </Typography>
      </Box>

      {portalOn === false ? (
        <AlertBanner tone="info">
          {t('contacts:portal.account.off')}{' '}
          <MuiLink component={Link} to={channelsRoute('portal')}>
            {t('contacts:portal.account.offLink')}
          </MuiLink>
        </AlertBanner>
      ) : null}
      {failed ? (
        <AlertBanner tone="danger">{t('contacts:portal.account.failed')}</AlertBanner>
      ) : null}

      <Box
        component="form"
        noValidate
        onSubmit={submit}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: 5,
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
        }}
      >
        <Box
          component="fieldset"
          disabled={!canWrite}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            border: 0,
            margin: 0,
            padding: 0,
          }}
        >
          <Typography
            variant="bodyStrong"
            component="legend"
            sx={{ marginBlockEnd: 2, padding: 0 }}
          >
            {t('contacts:portal.account.legend')}
          </Typography>
          {options.map((option) => (
            <RadioCard
              key={option.value}
              id={`${id}-${option.value}`}
              name={`${id}-visibility`}
              value={option.value}
              checked={draft.visibility === option.value}
              disabled={!canWrite}
              title={option.title}
              description={option.hint}
              onSelect={() => {
                choose(option.value);
              }}
            />
          ))}
        </Box>

        {sharesHistory(draft.visibility) ? (
          <AlertBanner tone="warning">{t('contacts:portal.account.warning')}</AlertBanner>
        ) : null}

        <Box>
          <Typography variant="bodyStrong" component="h3" sx={{ marginBlockEnd: 2 }}>
            {t('contacts:portal.account.members')}
          </Typography>
          {stored.members.length === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {t('contacts:portal.account.noMembers')}
            </Typography>
          ) : (
            <TableContainer
              sx={{
                borderRadius: '6px',
                border: `1px solid ${tokens['border.default']}`,
              }}
            >
              <Table aria-label={t('contacts:portal.account.members')}>
                <TableHead>
                  <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                    <TableCell>{t('contacts:portal.account.person')}</TableCell>
                    <TableCell>{t('contacts:portal.account.lastSignIn')}</TableCell>
                    <TableCell>{t('contacts:portal.account.manager')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {stored.members.map((member) => (
                    <TableRow key={member.contactId}>
                      <TableCell component="th" scope="row">
                        <MuiLink
                          component={Link}
                          to={contactRoute(member.contactId)}
                          variant="bodyStrong"
                        >
                          {member.name}
                        </MuiLink>
                        <Typography
                          variant="caption"
                          component="div"
                          sx={{ color: 'text.secondary' }}
                        >
                          <bdi>{member.email ?? DASH}</bdi>
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {member.lastSignInAt === null
                          ? t('contacts:portal.account.never')
                          : relativeWhen(member.lastSignInAt, now, locale)}
                      </TableCell>
                      <TableCell>
                        <Checkbox
                          size="small"
                          checked={draft.managerIds.includes(member.contactId)}
                          disabled={!canWrite || !managersOnly}
                          onChange={(event) => {
                            tick(member.contactId, event.target.checked);
                          }}
                          slotProps={{
                            input: {
                              'aria-label': t('contacts:portal.account.managerOf', {
                                name: member.name,
                              }),
                            },
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', display: 'block', marginBlockStart: 2 }}
          >
            {t('contacts:portal.account.managerNote')}
          </Typography>
        </Box>

        {canWrite ? (
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
            <Button
              variant="text"
              disabled={!changed || save.isPending}
              onClick={() => {
                setDraft(accountDraftOf(stored));
                setFailed(false);
              }}
            >
              {t('contacts:portal.account.discard')}
            </Button>
            <Button type="submit" variant="contained" disabled={!changed || save.isPending}>
              {t('contacts:portal.account.save')}
            </Button>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
