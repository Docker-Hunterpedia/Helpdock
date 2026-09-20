import { dir } from '@helpdock/i18n';
import type { TicketDetail, TicketPriority, TicketUpdateRequest } from '@helpdock/schemas';
import { Box, Button, Drawer } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TicketIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useReducer, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { useContactsApi, useTicketsApi } from '../../auth/session.tsx';
import { EmptyState } from '../../shell/empty-state.tsx';
import { ticketKeys } from '../../tickets/keys.js';
import { acknowledgedBy, type PendingMessage, pendingReducer } from '../../tickets/pending.js';
import { applyCatchUp, buildThread } from '../../tickets/thread.js';
import { useToast } from '../../ui/toasts.tsx';
import { Composer, type ComposerMode } from './composer.tsx';
import { DETAILS_WIDTH, DetailsPanel } from './details-panel.tsx';
import { assignableStaff } from './directory.js';
import { paragraph } from './format.js';
import { Thread, type ThreadNames } from './thread.tsx';
import { TicketHeader } from './ticket-header.tsx';
import { useTicketRoom } from './use-ticket-realtime.js';
import type { WorkspaceData } from './use-workspace-data.js';

/**
 * One ticket: the header, the thread and the composer, with the details panel
 * beside them or in a drawer.
 *
 * The optimistic half follows DOMAIN-RULES §7 exactly. A send draws its bubble
 * at once and holds a client-generated `clientId`; the bubble says "sending"
 * until the response carries a `seq`, and "not sent, retry" when ten seconds
 * pass without one. Retrying re-posts the *same* `clientId`, which the api
 * de-duplicates on `(conversation_id, client_id)` — so a retry of a request
 * that actually succeeded returns the original message rather than posting a
 * second one.
 */

const EXPIRY_TICK_MS = 1000;

export function TicketView({
  brandId,
  ticketId,
  directory,
  viewer,
  now,
  detailsInDrawer,
  detailsOpen,
  focusToken,
  onDetailsOpenChange,
  onGoToList,
}: {
  readonly brandId: string;
  readonly ticketId: string;
  readonly directory: WorkspaceData;
  readonly viewer: { readonly id: string; readonly name: string };
  readonly now: number;
  readonly detailsInDrawer: boolean;
  readonly detailsOpen: boolean;
  /** Changes when `r` or `n` was pressed, which is what moves the caret. */
  readonly focusToken: { readonly mode: ComposerMode; readonly at: number } | null;
  onDetailsOpenChange(open: boolean): void;
  onGoToList(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const api = useTicketsApi();
  const contactsApi = useContactsApi();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [mode, setMode] = useState<ComposerMode>('reply');
  const [body, setBody] = useState('');
  const [thenStatusId, setThenStatusId] = useState('');
  const [pending, dispatch] = useReducer(pendingReducer, [] as readonly PendingMessage[]);

  const detail = useQuery({
    queryKey: ticketKeys.detail(brandId, ticketId),
    queryFn: () => api.ticket(brandId, ticketId),
  });

  const { viewerIds } = useTicketRoom(brandId, ticketId, viewer.id);

  const contactId = detail.data?.ticket.contactId ?? null;

  const contact = useQuery({
    queryKey: ['contact', brandId, contactId],
    queryFn: () => contactsApi.contact(brandId, contactId ?? ''),
    enabled: contactId !== null,
  });

  /**
   * DOMAIN-RULES §1.2: a contact's history says how many tickets the viewer's
   * departments exclude. The timeline is the one read that answers it.
   */
  const timeline = useQuery({
    queryKey: ['contact-timeline', brandId, contactId],
    queryFn: () => contactsApi.timeline(brandId, contactId ?? ''),
    enabled: contactId !== null,
  });

  // A "sending" that has gone quiet for ten seconds is not sent (§7).
  useEffect(() => {
    if (!pending.some((message) => message.state === 'sending')) {
      return;
    }

    const timer = setInterval(() => {
      dispatch({ type: 'expired', now: Date.now() });
    }, EXPIRY_TICK_MS);

    return () => {
      clearInterval(timer);
    };
  }, [pending]);

  const messages = detail.data?.messages.messages ?? [];

  // Whatever the server's own copy has arrived for, this screen stops drawing.
  useEffect(() => {
    for (const clientId of acknowledgedBy(pending, messages)) {
      dispatch({ type: 'acknowledged', clientId });
    }
  }, [pending, messages]);

  // `r` and `n` both put the caret in the composer; `n` also switches it to a
  // note first. The caret itself is the composer's to move (`focusSignal`).
  useEffect(() => {
    if (focusToken !== null) {
      setMode(focusToken.mode);
    }
  }, [focusToken]);

  const send = useMutation({
    mutationFn: (message: PendingMessage) =>
      api.reply(brandId, ticketId, {
        kind: message.kind,
        bodyHtml: message.bodyHtml,
        clientId: message.clientId,
      }),
    onSuccess: async (saved, message) => {
      dispatch({ type: 'acknowledged', clientId: message.clientId });
      queryClient.setQueryData<TicketDetail>(ticketKeys.detail(brandId, ticketId), (held) =>
        held === undefined
          ? held
          : {
              ...held,
              messages: {
                ...held.messages,
                messages: applyCatchUp(held.messages.messages, [saved]),
              },
            },
      );
      toast({
        tone: 'success',
        message: t(message.kind === 'note' ? 'tickets:toast.noted' : 'tickets:toast.replied'),
      });

      // "Then set status" is applied after the send, never with it: a status
      // moved by a reply that never left would be a lie about what happened.
      if (thenStatusId !== '') {
        await update.mutateAsync({ statusId: thenStatusId });
        setThenStatusId('');
      }

      await queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brandId, ticketId) });
      await queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brandId) });
    },
    onError: (_error, message) => {
      dispatch({ type: 'failed', clientId: message.clientId });
      toast({ tone: 'danger', message: t('tickets:toast.sendFailed') });
    },
  });

  const update = useMutation({
    mutationFn: (patch: TicketUpdateRequest) => api.update(brandId, ticketId, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brandId, ticketId) });
      await queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brandId) });
      toast({ tone: 'success', message: t('tickets:toast.updated') });
    },
    onError: () => {
      toast({ tone: 'danger', message: t('tickets:toast.failed') });
    },
  });

  const names = useMemo<ThreadNames>(
    () => ({
      nameFor: (authorType, authorId) => {
        if (authorId === null) {
          return null;
        }
        if (authorType === 'contact') {
          return directory.contactNames.get(authorId) ?? null;
        }
        if (authorId === viewer.id) {
          return viewer.name;
        }

        return (
          directory.staff.find((member) => member.userId === authorId)?.name ??
          directory.contactNames.get(authorId) ??
          null
        );
      },
      addressFor: (authorId) =>
        authorId === null ? null : (directory.contactAddresses.get(authorId) ?? null),
    }),
    [directory, viewer],
  );

  const viewerNames = viewerIds.map(
    (id) => directory.staff.find((member) => member.userId === id)?.name ?? id.slice(0, 8),
  );

  if (detail.isError) {
    return (
      <Box sx={{ padding: 8 }}>
        <EmptyState
          icon={TicketIcon}
          heading={t('tickets:error.ticketHeading')}
          body={t('tickets:error.ticketBody')}
          action={
            <Button variant="outlined" onClick={onGoToList}>
              {t('tickets:error.backToList')}
            </Button>
          }
        />
      </Box>
    );
  }

  const ticket = detail.data?.ticket;
  if (ticket === undefined) {
    return <Box sx={{ padding: 8 }} aria-busy="true" />;
  }

  const items = buildThread(messages, detail.data?.activity ?? [], pending);
  const staffOptions = assignableStaff(directory.staff, viewer, ticket.assigneeId);
  const departmentName = directory.departments.find(
    (department) => department.id === ticket.departmentId,
  )?.name;

  const details = (
    <DetailsPanel
      ticket={ticket}
      contact={contact.data ?? null}
      hiddenTicketCount={timeline.data?.hiddenCount ?? 0}
      statuses={directory.statuses}
      departments={directory.departments}
      staff={staffOptions}
      now={now}
      busy={update.isPending}
      onChange={(patch) => {
        update.mutate(patchOf(patch));
      }}
    />
  );

  const queueSend = (): void => {
    const text = body.trim();
    if (text === '') {
      return;
    }

    const message: PendingMessage = {
      clientId: crypto.randomUUID(),
      kind: mode === 'note' ? 'note' : 'public',
      bodyHtml: paragraph(text),
      bodyText: text,
      createdAt: new Date().toISOString(),
      sentAt: Date.now(),
      state: 'sending',
    };

    dispatch({ type: 'queued', message });
    setBody('');
    send.mutate(message);
  };

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <TicketHeader
          ticket={ticket}
          departmentName={departmentName}
          viewers={viewerNames}
          now={now}
          showDetailsButton={detailsInDrawer}
          onShowDetails={() => {
            onDetailsOpenChange(true);
          }}
        />

        {/* Focusable because it scrolls: a region a mouse can scroll and a
            keyboard cannot is WCAG 2.1.1 (DESIGN §10). */}
        <Box
          tabIndex={0}
          aria-label={t('tickets:thread.label')}
          sx={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 5 }}
        >
          <Thread
            items={items}
            names={names}
            now={now}
            onRetry={(message) => {
              dispatch({ type: 'retried', clientId: message.clientId, now: Date.now() });
              send.mutate({ ...message, state: 'sending', sentAt: Date.now() });
            }}
            onDiscard={(message) => {
              dispatch({ type: 'discarded', clientId: message.clientId });
            }}
          />
        </Box>

        <Box
          sx={{
            padding: 5,
            borderBlockStart: `1px solid ${tokens['border.default']}`,
            backgroundColor: tokens['bg.canvas'],
          }}
        >
          <Composer
            mode={mode}
            body={body}
            recipient={contact.data?.name ?? null}
            statuses={directory.statuses}
            thenStatusId={thenStatusId}
            busy={send.isPending}
            attachmentsAvailable={false}
            focusSignal={focusToken?.at}
            onModeChange={setMode}
            onBodyChange={setBody}
            onThenStatusChange={setThenStatusId}
            onSend={queueSend}
          />
        </Box>
      </Box>

      {detailsInDrawer ? (
        <Drawer
          // DESIGN §6.4: a drawer opens from the inline end, which is the left
          // in Arabic. MUI's `anchor` is physical, so the direction picks it.
          anchor={dir(locale) === 'rtl' ? 'left' : 'right'}
          open={detailsOpen}
          onClose={() => {
            onDetailsOpenChange(false);
          }}
          slotProps={{ paper: { sx: { width: DETAILS_WIDTH, maxWidth: '100%' } } }}
        >
          {details}
        </Drawer>
      ) : (
        details
      )}
    </Box>
  );
}

/** Only the fields that were named; `assigneeId` may legitimately be null. */
const patchOf = (patch: {
  statusId?: string;
  priority?: TicketPriority;
  departmentId?: string;
  assigneeId?: string | null;
}): TicketUpdateRequest => ({
  ...(patch.statusId === undefined ? {} : { statusId: patch.statusId }),
  ...(patch.priority === undefined ? {} : { priority: patch.priority }),
  ...(patch.departmentId === undefined ? {} : { departmentId: patch.departmentId }),
  ...(patch.assigneeId === undefined ? {} : { assigneeId: patch.assigneeId }),
});
