import type { Mailbox } from '@helpdock/schemas';
import {
  Box,
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
import { Inbox, Pencil, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { channelsRoute, mailboxRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { currentBrand, useChannelsApi, useSession } from '../../../auth/session.tsx';
import { EmptyState } from '../../../shell/empty-state.tsx';
import { ActionsMenu } from '../../../ui/actions-menu.tsx';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import { ago, clockTime } from './format.js';
import { HealthDot, HealthLegend } from './health.tsx';
import { InboundParseCard } from './inbound-parse-card.tsx';

/**
 * Channels › Mailboxes (M2-08), the `Admin · email channel` artboard: the
 * mailbox table with each one's health, the "replies go out once per brand"
 * note, the health legend, and the inbound-parse endpoints card.
 */
export function MailboxesTab(): ReactNode {
  const t = useT();
  const api = useChannelsApi();
  const brand = currentBrand(useSession());
  const tokens = useSemanticTokens();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [deleting, setDeleting] = useState<Mailbox | null>(null);

  const mailboxes = useQuery({
    queryKey: ['mailboxes', brand.id],
    queryFn: () => api.mailboxes(brand.id),
  });

  const remove = useMutation({
    mutationFn: (mailbox: Mailbox) => api.deleteMailbox(brand.id, mailbox.id),
    onSuccess: async (_result, mailbox) => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: ['mailboxes', brand.id] });
      toast({
        tone: 'success',
        message: t('channels:toast.deleted', { address: mailbox.address }),
      });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('channels:toast.failed') });
    },
  });

  const rows = mailboxes.data?.mailboxes ?? [];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Box
        component="section"
        aria-labelledby={headingId}
        sx={{
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            paddingBlock: '14px',
            paddingInline: 4,
            display: 'flex',
            alignItems: 'baseline',
            gap: 2,
            flexWrap: 'wrap',
          }}
        >
          <Typography id={headingId} variant="h3" component="h2" sx={{ fontSize: 16 }}>
            {t('channels:mailboxes.heading')}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('channels:mailboxes.caption', { count: rows.length })}
          </Typography>
        </Box>

        {rows.length === 0 && !mailboxes.isPending ? (
          <Box sx={{ padding: 6 }}>
            <EmptyState
              icon={Inbox}
              heading={t('channels:mailboxes.empty.heading')}
              body={t('channels:mailboxes.empty.body')}
            />
          </Box>
        ) : (
          <TableContainer>
            <Table aria-labelledby={headingId} sx={{ tableLayout: 'fixed' }}>
              <TableHead>
                <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                  <TableCell>{t('channels:mailboxes.columns.address')}</TableCell>
                  <TableCell sx={{ width: 140 }}>
                    {t('channels:mailboxes.columns.routesTo')}
                  </TableCell>
                  <TableCell>{t('channels:mailboxes.columns.incoming')}</TableCell>
                  <TableCell sx={{ width: 300 }}>
                    {t('channels:mailboxes.columns.health')}
                  </TableCell>
                  <TableCell sx={{ width: 48 }}>
                    <Box component="span" sx={visuallyHiddenSx}>
                      {t('channels:mailboxes.columns.actions')}
                    </Box>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((mailbox) => (
                  <TableRow key={mailbox.id} sx={{ height: 44 }}>
                    <TableCell sx={ellipsisSx}>
                      <MuiLink
                        component={Link}
                        to={mailboxRoute(mailbox.id)}
                        sx={{ color: 'text.primary', fontWeight: 500 }}
                      >
                        <bdi>{mailbox.address}</bdi>
                      </MuiLink>
                      <Box component="span" sx={{ color: 'text.secondary' }}>
                        {' · '}
                        <bdi>{mailbox.displayName}</bdi>
                      </Box>
                    </TableCell>
                    <TableCell>{mailbox.departmentName}</TableCell>
                    <TableCell sx={ellipsisSx}>
                      <Incoming mailbox={mailbox} />
                    </TableCell>
                    <TableCell>
                      <HealthCell mailbox={mailbox} />
                    </TableCell>
                    <TableCell>
                      <ActionsMenu
                        label={t('channels:mailboxes.actionsFor', { address: mailbox.address })}
                        menuLabel={t('channels:mailboxes.actionsFor', { address: mailbox.address })}
                        items={[
                          {
                            id: 'edit',
                            label: t('channels:mailboxes.edit'),
                            icon: Pencil,
                            onSelect: () => {
                              void navigate(mailboxRoute(mailbox.id));
                            },
                          },
                          {
                            id: 'delete',
                            label: t('channels:mailboxes.delete'),
                            icon: Trash2,
                            tone: 'danger',
                            dividerBefore: true,
                            onSelect: () => {
                              setDeleting(mailbox);
                            },
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <NoteCard heading={t('channels:replies.heading')}>
            {t('channels:replies.body')}{' '}
            <MuiLink component={Link} to={channelsRoute('outgoing')}>
              {t('channels:replies.link')}
            </MuiLink>
            .
          </NoteCard>
          <NoteCard heading={t('channels:legend.heading')}>
            <HealthLegend />
          </NoteCard>
        </Box>
        <InboundParseCard />
      </Box>

      <ConfirmDialog
        open={deleting !== null}
        title={t('channels:form.deleteConfirm.title', { address: deleting?.address ?? '' })}
        body={t('channels:form.deleteConfirm.body')}
        confirmLabel={t('channels:form.deleteConfirm.action')}
        destructive
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
        }}
        onClose={() => {
          setDeleting(null);
        }}
      />
    </Box>
  );
}

const ellipsisSx = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;

const visuallyHiddenSx = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

function Incoming({ mailbox }: { readonly mailbox: Mailbox }): ReactNode {
  const t = useT();
  const detail =
    mailbox.method === 'imap'
      ? (mailbox.imap?.host ?? '')
      : mailbox.inboundProvider === null
        ? t('channels:mailboxes.noProvider')
        : providerName(t, mailbox.inboundProvider);

  return (
    <>
      <span>{t(`channels:mailboxes.incoming.${mailbox.method}`)}</span>
      <Typography
        variant={mailbox.method === 'imap' ? 'mono' : 'caption'}
        component="span"
        sx={{ fontSize: 12, color: 'text.secondary' }}
      >
        {' · '}
        <bdi>{detail}</bdi>
      </Typography>
    </>
  );
}

const providerName = (t: ReturnType<typeof useT>, provider: string): string => {
  switch (provider) {
    case 'postmark':
    case 'sendgrid':
    case 'mailgun':
    case 'resend':
    case 'generic':
      return t(`channels:mailboxes.providers.${provider}`);
    default:
      return provider;
  }
};

function HealthCell({ mailbox }: { readonly mailbox: Mailbox }): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const [now] = useState(Date.now);
  const { health } = mailbox;

  const when =
    health.state === 'failing' && health.lastErrorAt !== null
      ? clockTime(health.lastErrorAt, locale)
      : mailbox.method === 'inbound_parse'
        ? health.lastReceivedAt === null
          ? null
          : t('channels:health.lastMail', { ago: ago(health.lastReceivedAt, now, locale) })
        : health.lastPolledAt === null
          ? null
          : t('channels:health.polled', { ago: ago(health.lastPolledAt, now, locale) });

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, whiteSpace: 'nowrap' }}>
      <HealthDot mailbox={mailbox} />
      {when === null ? null : (
        <Typography variant="mono" component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
          {when}
        </Typography>
      )}
      {health.state === 'failing' ? (
        <MuiLink
          component={Link}
          to={mailboxRoute(mailbox.id)}
          aria-label={t('channels:health.fixFor', { address: mailbox.address })}
          sx={{ fontSize: 12, fontWeight: 500 }}
        >
          {t('channels:health.fix')}
        </MuiLink>
      ) : null}
    </Box>
  );
}

function NoteCard({
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
      <Typography variant="bodyStrong" component="h3" sx={{ fontSize: 13, color: 'text.primary' }}>
        {heading}
      </Typography>
      <Box>{children}</Box>
    </Box>
  );
}
