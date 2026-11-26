import { Box, Button, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useContactsApi, useSession } from '../../auth/session.tsx';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { LoadingSkeleton } from '../../ui/loading-skeleton.tsx';
import { useToast } from '../../ui/toasts.tsx';
import { relativeWhen } from './portal-format.js';

/**
 * The "Customer portal" card of the contact page (M21-06,
 * `Admin/Contact-PortalAccess`): whether the contact has signed in, the address
 * they sign in with, what they see and why, each browser they are signed in on,
 * and Sign out everywhere behind a confirmation.
 *
 * Nothing here can show a session token, a hash or an address of a network: the
 * api's answer has no field for them (`contactPortalAccessSchema`). Signing out
 * needs `contact:write`; a Viewer reads the card.
 */
export function ContactPortalCard({
  contactId,
  contactName,
  accountName,
}: {
  readonly contactId: string;
  readonly contactName: string;
  readonly accountName: string | null;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const api = useContactsApi();
  const queryClient = useQueryClient();
  const { locale } = usePreferences();
  const canWrite = useSession().user.role !== 'viewer';
  const brand = currentBrand(useSession());
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [now] = useState(() => Date.now());
  const key = ['contact-portal', brand.id, contactId];

  const access = useQuery({ queryKey: key, queryFn: () => api.contactPortal(brand.id, contactId) });

  const signOut = useMutation({
    mutationFn: () => api.signOutOfPortal(brand.id, contactId),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: key });
      toast({
        tone: 'success',
        message: t('contacts:portal.contact.signedOut', { name: contactName }),
      });
    },
    onError: () => {
      setConfirming(false);
      toast({ tone: 'danger', message: t('contacts:portal.contact.failed') });
    },
  });

  const data = access.data;
  const first = contactName.split(/\s+/)[0] ?? contactName;

  return (
    <Box
      component="section"
      aria-labelledby={`${id}-heading`}
      sx={{
        display: 'grid',
        gap: 3,
        padding: 5,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography id={`${id}-heading`} variant="h3" component="h2">
          {t('contacts:portal.contact.heading')}
        </Typography>
        {data?.signedIn === true ? (
          <Typography
            variant="caption"
            component="span"
            sx={{
              blockSize: 22,
              paddingInline: 2,
              borderRadius: '6px',
              display: 'inline-flex',
              alignItems: 'center',
              fontWeight: 500,
              backgroundColor: tokens['status.success.tint'],
              color: tokens['status.success.text'],
            }}
          >
            {t('contacts:portal.contact.signedIn')}
          </Typography>
        ) : null}
      </Box>

      {access.isError ? (
        <AlertBanner tone="danger">{t('contacts:portal.contact.loadFailed')}</AlertBanner>
      ) : data === undefined ? (
        <LoadingSkeleton />
      ) : !data.signedIn ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('contacts:portal.contact.never', { name: first })}
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'grid', gap: 2 }}>
            <Row label={t('contacts:portal.contact.signsInWith')}>
              <bdi>{data.signsInWith}</bdi>
            </Row>
            <Row label={t('contacts:portal.contact.sees')}>
              <bdi>
                {t(`contacts:portal.contact.seesBecause.${data.seesBecause}`, {
                  account: accountName ?? '',
                })}
              </bdi>
            </Row>
          </Box>

          <Box
            component="ul"
            aria-label={t('contacts:portal.contact.sessions')}
            sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}
          >
            {data.sessions.map((session) => (
              <Box key={session.id} component="li">
                <Typography variant="bodyStrong" component="div">
                  {session.userAgentFamily ?? t('contacts:portal.contact.unknownBrowser')}
                </Typography>
                <Typography variant="caption" component="div" sx={{ color: 'text.secondary' }}>
                  {t('contacts:portal.contact.lastUsed', {
                    when: relativeWhen(session.lastSeenAt, now, locale),
                  })}
                  {' · '}
                  <bdi dir="ltr">{session.host}</bdi>
                </Typography>
              </Box>
            ))}
          </Box>

          {canWrite ? (
            <Button
              variant="outlined"
              size="small"
              aria-haspopup="dialog"
              startIcon={<LogOut size={14} aria-hidden="true" className="mirror-in-rtl" />}
              sx={{ justifySelf: 'start' }}
              onClick={() => {
                setConfirming(true);
              }}
            >
              {t('contacts:portal.contact.signOut')}
            </Button>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={confirming}
        destructive
        busy={signOut.isPending}
        title={t('contacts:portal.contact.confirmTitle', { name: contactName })}
        body={t('contacts:portal.contact.confirmBody', {
          count: data?.sessions.length ?? 0,
          name: first,
        })}
        confirmLabel={t('contacts:portal.contact.signOut')}
        onConfirm={() => {
          signOut.mutate();
        }}
        onClose={() => {
          setConfirming(false);
        }}
      />
    </Box>
  );
}

function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 3 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ textAlign: 'end' }}>
        {children}
      </Typography>
    </Box>
  );
}
