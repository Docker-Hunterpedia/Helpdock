import type { TicketParticipantList } from '@helpdock/schemas';
import { Box, Button, IconButton, TextField, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { currentBrand, useSession, useTicketsApi } from '../../auth/session.tsx';
import { isContactError } from '../../contacts/api.js';
import { useToast } from '../../ui/toasts.tsx';

/**
 * The Participants card of the ticket details panel (M1-13), the right-hand
 * card of panel 8 on `Admin/Ticket dialogs`: the ticket's contact, its CCs with
 * a remove button each, and a field to copy somebody in (DOMAIN-RULES §2.5).
 *
 * Which of them may thread into the ticket by email and who receives public
 * replies is M2's to act on; this card keeps the list and says so in its hint.
 * The staff participants the api also lists are not drawn: the artboard does
 * not, and every one of them is already on the thread by name.
 */
export function ParticipantsCard({ ticketId }: { readonly ticketId: string }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const session = useSession();
  const api = useTicketsApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const inputId = useId();
  const brand = currentBrand(session);
  const [address, setAddress] = useState('');
  const key = ['ticket-participants', brand.id, ticketId];

  const participants = useQuery({
    queryKey: key,
    queryFn: () => api.participants(brand.id, ticketId),
  });

  const settle = (list: TicketParticipantList): void => {
    queryClient.setQueryData(key, list);
  };

  const failure = (error: unknown): void => {
    toast({
      tone: 'danger',
      message:
        isContactError(error) && error.problem !== undefined
          ? t(`contacts:problem.${error.problem}`)
          : t('tickets:participants.failed'),
    });
  };

  const add = useMutation({
    mutationFn: (email: string) => api.addCc(brand.id, ticketId, { email }),
    onSuccess: (list, email) => {
      settle(list);
      setAddress('');
      toast({ tone: 'success', message: t('tickets:participants.added', { address: email }) });
    },
    onError: failure,
  });

  const remove = useMutation({
    mutationFn: ({ id }: { id: string; label: string }) => api.removeCc(brand.id, ticketId, id),
    onSuccess: (list, { label }) => {
      settle(list);
      toast({ tone: 'success', message: t('tickets:participants.removed', { address: label }) });
    },
    onError: failure,
  });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const email = address.trim();
    if (email !== '') {
      add.mutate(email);
    }
  };

  const list = participants.data;

  return (
    <Box
      component="section"
      aria-labelledby={`${inputId}-title`}
      sx={{
        display: 'grid',
        gap: 3,
        padding: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography id={`${inputId}-title`} variant="bodyStrong" component="h2">
        {t('tickets:participants.title')}
      </Typography>

      <Box
        component="ul"
        sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}
      >
        {list?.contact === null || list?.contact === undefined ? null : (
          <Box component="li" sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0 }}>
              {list.contact.name}
            </Typography>
            <Pill tone="neutral">{t('tickets:participants.contact')}</Pill>
          </Box>
        )}
        {(list?.ccs ?? []).map((cc) => {
          const label = cc.address ?? cc.name;

          return (
            <Box key={cc.id} component="li" sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Typography variant="body2" sx={{ flexGrow: 1, minWidth: 0 }}>
                <bdi>{label}</bdi>
              </Typography>
              <Pill tone="info">{t('tickets:participants.cc')}</Pill>
              <IconButton
                size="small"
                disabled={remove.isPending}
                aria-label={t('tickets:participants.remove', { address: label })}
                onClick={() => {
                  remove.mutate({ id: cc.id, label });
                }}
              >
                <X size={14} aria-hidden="true" />
              </IconButton>
            </Box>
          );
        })}
      </Box>

      <Box component="form" noValidate onSubmit={submit} sx={{ display: 'flex', gap: 2 }}>
        <TextField
          id={inputId}
          type="email"
          size="small"
          value={address}
          placeholder={t('tickets:participants.addPlaceholder')}
          slotProps={{ htmlInput: { 'aria-label': t('tickets:participants.addLabel') } }}
          onChange={(event) => {
            setAddress(event.target.value);
          }}
          sx={{ flexGrow: 1, minWidth: 0 }}
        />
        <Button
          type="submit"
          size="small"
          variant="outlined"
          disabled={add.isPending || address.trim() === ''}
        >
          {t('tickets:participants.add')}
        </Button>
      </Box>

      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:participants.hint')}
      </Typography>
    </Box>
  );
}

/** The 22 px label beside a participant: "contact" on neutral, "CC" on the info tint. */
function Pill({
  tone,
  children,
}: {
  readonly tone: 'neutral' | 'info';
  readonly children: ReactNode;
}): ReactNode {
  const tokens = useSemanticTokens();

  return (
    <Typography
      variant="caption"
      component="span"
      sx={{
        blockSize: 22,
        paddingInline: 2,
        borderRadius: '6px',
        display: 'inline-flex',
        alignItems: 'center',
        whiteSpace: 'nowrap',
        fontWeight: 500,
        backgroundColor: tone === 'info' ? tokens['status.info.tint'] : tokens['bg.muted'],
        color: tone === 'info' ? tokens['status.info.text'] : tokens['text.secondary'],
      }}
    >
      {children}
    </Typography>
  );
}
