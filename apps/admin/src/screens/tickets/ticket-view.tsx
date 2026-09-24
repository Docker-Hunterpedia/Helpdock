import { dir } from '@helpdock/i18n';
import type {
  Attachment,
  TicketDetail,
  TicketPriority,
  TicketUpdateRequest,
} from '@helpdock/schemas';
import { DEFAULT_CONTENT_POLICY } from '@helpdock/schemas';
import { Box, Button, Drawer } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TicketIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useReducer, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import {
  useAttachmentUploader,
  useContactsApi,
  useTicketingApi,
  useTicketsApi,
} from '../../auth/session.tsx';
import { isUploadError, wouldAccept } from '../../media/upload.js';
import { EmptyState } from '../../shell/empty-state.tsx';
import { isTicketingError } from '../../ticketing/api.js';
import { refusalCopy } from '../../ticketing/refusal-copy.js';
import { ticketKeys } from '../../tickets/keys.js';
import { acknowledgedBy, type PendingMessage, pendingReducer } from '../../tickets/pending.js';
import { applyCatchUp, buildThread } from '../../tickets/thread.js';
import { useToast } from '../../ui/toasts.tsx';
import { Composer, type ComposerMode } from './composer.tsx';
import { DETAILS_WIDTH, DetailsPanel } from './details-panel.tsx';
import { assigneeName } from './directory.js';
import { paragraph } from './format.js';
import { Thread, type ThreadNames } from './thread.tsx';
import { TicketHeader } from './ticket-header.tsx';
import { useSpamActions } from './use-spam-actions.tsx';
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
  const ticketingApi = useTicketingApi();
  const uploader = useAttachmentUploader();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [mode, setMode] = useState<ComposerMode>('reply');
  const [body, setBody] = useState('');
  const [thenStatusId, setThenStatusId] = useState('');
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pending, dispatch] = useReducer(pendingReducer, [] as readonly PendingMessage[]);

  const detail = useQuery({
    queryKey: ticketKeys.detail(brandId, ticketId),
    queryFn: () => api.ticket(brandId, ticketId),
  });

  const { viewerIds } = useTicketRoom(brandId, ticketId, viewer.id);

  // M1-11: "Mark as spam" / "Not spam" in the header menu, and its dialog.
  const spam = useSpamActions(brandId, detail.data?.ticket);

  /**
   * The brand's content policy, for the picker's courtesy check. It is the
   * brand read M1-01 added rather than a copy of the defaults: a brand that
   * has turned video off must not be offered a video picker that then fails.
   */
  const brand = useQuery({
    queryKey: ['brand', brandId],
    queryFn: () => ticketingApi.brand(brandId),
    staleTime: 60_000,
    retry: false,
  });
  const policy = brand.data?.settings.contentPolicy ?? DEFAULT_CONTENT_POLICY;

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
        ...(message.attachmentIds.length === 0
          ? {}
          : { attachmentIds: [...message.attachmentIds] }),
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
      // A new assignee moves two people's counts in the picker.
      await queryClient.invalidateQueries({ queryKey: ticketKeys.assignables(brandId) });
      toast({ tone: 'success', message: t('tickets:toast.updated') });
    },
    onError: (error) => {
      // M1-07's refusals — somebody who cannot work the department, or an
      // Admin chosen by somebody who is not one — say which rule it was.
      toast({
        tone: 'danger',
        message: isTicketingError(error) ? t(refusalCopy(error.reason)) : t('tickets:toast.failed'),
      });
    },
  });

  /** M1-07: the picker's options for the department the ticket is in now. */
  const departmentId = detail.data?.ticket.departmentId;
  const assignable = useQuery({
    queryKey: ticketKeys.assignable(brandId, departmentId ?? ''),
    queryFn: () => api.assignable(brandId, departmentId ?? ''),
    enabled: departmentId !== undefined,
    staleTime: 30_000,
    retry: false,
  });

  const names = useMemo<ThreadNames>(
    () => ({
      nameFor: (authorType, authorId) => {
        if (authorId === null) {
          return null;
        }
        // The customer side of a thread is the ticket's own contact: the
        // embedded name first, which arrives with the ticket, then the full
        // read, which also knows the address.
        if (authorType === 'contact') {
          if (authorId === contact.data?.id) {
            return contact.data.name;
          }
          return authorId === detail.data?.ticket.contact?.id
            ? detail.data.ticket.contact.name
            : null;
        }
        if (authorId === viewer.id) {
          return viewer.name;
        }

        return directory.staff.find((member) => member.userId === authorId)?.name ?? null;
      },
      addressFor: (authorId) =>
        authorId !== null && authorId === contact.data?.id
          ? (contact.data.primaryIdentity?.value ?? null)
          : null,
    }),
    [directory, viewer, contact.data, detail.data],
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
  const agents = assignable.data?.agents ?? [];
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
      assignee={{
        name: assigneeName(ticket.assigneeId, { agents, staff: directory.staff, viewer }),
        agents,
        loadCap: assignable.data?.loadCap ?? null,
        unavailable: assignable.isError,
      }}
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
      attachmentIds: attachments.map((attachment) => attachment.id),
      createdAt: new Date().toISOString(),
      sentAt: Date.now(),
      state: 'sending',
    };

    dispatch({ type: 'queued', message });
    setBody('');
    setAttachments([]);
    send.mutate(message);
  };

  /**
   * Each file goes up as it is chosen. The policy check first, so a file the
   * brand would refuse costs no bytes; the api applies the same rules to the
   * presign request and again to the stored object.
   */
  const attach = async (files: readonly File[]): Promise<void> => {
    setUploading(true);
    try {
      for (const file of files) {
        const verdict = wouldAccept(policy, file);
        if (!verdict.ok) {
          toast({ tone: 'danger', message: t(`tickets:attachments.${verdict.problem}`) });
          continue;
        }

        try {
          const uploaded = await uploader.upload({ brandId, ticketId, file });
          setAttachments((held) => [...held, uploaded]);
        } catch (error) {
          toast({
            tone: 'danger',
            message: t(
              isUploadError(error)
                ? `tickets:attachments.${error.problem}`
                : 'tickets:attachments.upload_failed',
            ),
          });
        }
      }
    } finally {
      setUploading(false);
    }
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
          actions={spam.items}
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
            attachments={attachments}
            uploading={uploading}
            // Until the brand read answers, the defaults are what the picker
            // measures against; the api is the one that decides either way.
            attachmentsEnabled={!brand.isPending || brand.isError}
            focusSignal={focusToken?.at}
            onModeChange={setMode}
            onBodyChange={setBody}
            onThenStatusChange={setThenStatusId}
            onAttach={(files) => {
              void attach(files);
            }}
            onRemoveAttachment={(attachmentId) => {
              setAttachments((held) => held.filter((row) => row.id !== attachmentId));
            }}
            onSend={queueSend}
          />
        </Box>
      </Box>

      {spam.dialog}

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
