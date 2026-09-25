import { dir } from '@helpdock/i18n';
import type {
  Attachment,
  TicketDetail,
  TicketMergeResult,
  TicketPriority,
  TicketSplitRequest,
  TicketUpdateRequest,
} from '@helpdock/schemas';
import { DEFAULT_CONTENT_POLICY } from '@helpdock/schemas';
import { Box, Button, Drawer } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, GitMerge, Split, TicketIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useReducer, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import {
  useAttachmentUploader,
  useContactsApi,
  useSession,
  useTicketingApi,
  useTicketsApi,
} from '../../auth/session.tsx';
import { isUploadError, wouldAccept } from '../../media/upload.js';
import { EmptyState } from '../../shell/empty-state.tsx';
import { isTicketingError } from '../../ticketing/api.js';
import { refusalCopy } from '../../ticketing/refusal-copy.js';
import { isTicketLifecycleError } from '../../tickets/api.js';
import { ticketFieldsFor } from '../../tickets/custom-values.js';
import { ticketKeys } from '../../tickets/keys.js';
import { mergeCandidates, visibleLinks } from '../../tickets/merge.js';
import { acknowledgedBy, type PendingMessage, pendingReducer } from '../../tickets/pending.js';
import { applyCatchUp, buildThread } from '../../tickets/thread.js';
import { useToast } from '../../ui/toasts.tsx';
import { Composer, type ComposerMode } from './composer.tsx';
import { CsatCard } from './csat-card.tsx';
import { DETAILS_WIDTH, DetailsPanel } from './details-panel.tsx';
import { assigneeName } from './directory.js';
import { paragraph, ticketReference } from './format.js';
import { LogTimeDialog } from './log-time-dialog.tsx';
import { MergeDialog } from './merge-dialog.tsx';
import { MergedIntoBanner } from './merged-block.tsx';
import { SplitDialog } from './split-dialog.tsx';
import { Thread, type ThreadNames } from './thread.tsx';
import type { TicketAction } from './ticket-actions-menu.tsx';
import { TicketHeader } from './ticket-header.tsx';
import { TimeCard } from './time-card.tsx';
import { loggableSeconds } from './time-format.js';
import { useSpamActions } from './use-spam-actions.tsx';
import { useTicketRoom } from './use-ticket-realtime.js';
import { useTicketTags } from './use-ticket-tags.js';
import { useTicketTimer } from './use-ticket-timer.js';
import { useTimeEntries } from './use-time-entries.js';
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

/** How many tickets the merge dialog offers at once; the search narrows the rest. */
const MERGE_SEARCH_LIMIT = 8;

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
  onOpenTicket,
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
  /** M1-09: where a merge or a split sends the reader afterwards. */
  onOpenTicket(ticketId: string): void;
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
  // M1-09: the ⋯ menu's two dialogs, and what the merge search last asked for.
  const [dialog, setDialog] = useState<'merge' | 'split' | null>(null);
  const [mergeTerm, setMergeTerm] = useState('');

  const detail = useQuery({
    queryKey: ticketKeys.detail(brandId, ticketId),
    queryFn: () => api.ticket(brandId, ticketId),
  });

  // "Is replying" while the composer holds something unsent (M1-09).
  const { viewers } = useTicketRoom(
    brandId,
    ticketId,
    viewer.id,
    body.trim() === '' ? 'viewing' : 'replying',
  );

  const mergeSearch = useQuery({
    queryKey: ticketKeys.list(brandId, { q: mergeTerm.trim(), limit: MERGE_SEARCH_LIMIT }),
    queryFn: () =>
      api.list(brandId, {
        ...(mergeTerm.trim() === '' ? {} : { q: mergeTerm.trim() }),
        limit: MERGE_SEARCH_LIMIT,
      }),
    enabled: dialog === 'merge',
  });

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

  // M1-12. The Time card, its timer and "Log time…" exist only while the
  // brand tracks time; a Viewer reads the card and cannot write to it.
  const { role } = useSession().user;
  const tracking = brand.data?.settings.timeTrackingEnabled === true;
  const timerWithComposer = brand.data?.settings.timerStartsWithComposer === true;
  const canWrite = role !== 'viewer';
  const timer = useTicketTimer(ticketId);

  // M1-15: the tags row and the editable custom fields. The definitions share
  // the Custom fields tab's key, so an edit there is what the panel draws next.
  const tags = useTicketTags(brandId, ticketId, directory.tags);
  const fieldDefs = useQuery({
    queryKey: ['custom-fields', brandId],
    queryFn: () => ticketingApi.customFields(brandId),
    staleTime: 60_000,
  });
  const saveCustom = useMutation({
    mutationFn: (custom: Record<string, unknown>) => api.update(brandId, ticketId, { custom }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brandId, ticketId) });
      toast({ tone: 'success', message: t('tickets:toast.updated') });
    },
  });
  const time = useTimeEntries(brandId, ticketId, tracking);
  const [logOpen, setLogOpen] = useState(false);

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
        ...(message.timeSpentSeconds === undefined
          ? {}
          : { timeSpentSeconds: message.timeSpentSeconds }),
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
      if (message.timeSpentSeconds !== undefined) {
        await time.refresh();
      }
    },
    onError: (_error, message) => {
      dispatch({ type: 'failed', clientId: message.clientId });
      toast({ tone: 'danger', message: t('tickets:toast.sendFailed') });
    },
  });

  /**
   * A refusal a person can act on gets its sentence: the lifecycle's (M1-08,
   * M1-09) or the ticketing settings' (M1-07's assignee rules); anything else,
   * the one for failure.
   */
  const refused = (error: unknown): void => {
    toast({
      tone: 'danger',
      message: isTicketLifecycleError(error)
        ? t(`tickets:lifecycle.${error.reason}`)
        : isTicketingError(error)
          ? t(refusalCopy(error.reason))
          : t('tickets:toast.failed'),
    });
  };

  const update = useMutation({
    mutationFn: (patch: TicketUpdateRequest) => api.update(brandId, ticketId, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brandId, ticketId) });
      await queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brandId) });
      // A new assignee moves two people's counts in the picker.
      await queryClient.invalidateQueries({ queryKey: ticketKeys.assignables(brandId) });
      toast({ tone: 'success', message: t('tickets:toast.updated') });
    },
    onError: refused,
  });

  /** Both tickets moved, so both reads, every list and every count are stale. */
  const refreshPair = async (result: TicketMergeResult): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brandId, result.primary.id) }),
      queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brandId, result.secondary.id) }),
      queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brandId) }),
      queryClient.invalidateQueries({ queryKey: ticketKeys.counts(brandId) }),
    ]);
  };

  const merge = useMutation({
    mutationFn: (primaryTicketId: string) => api.merge(brandId, ticketId, { primaryTicketId }),
    onSuccess: async (result) => {
      setDialog(null);
      await refreshPair(result);
      toast({
        tone: 'success',
        message: t('tickets:toast.merged', { reference: ticketReference(result.primary) }),
      });
      // The ticket that stays open is where the work continues.
      onOpenTicket(result.primary.id);
    },
    onError: refused,
  });

  const unmerge = useMutation({
    mutationFn: (secondaryId: string) => api.unmerge(brandId, secondaryId),
    onSuccess: async (result) => {
      await refreshPair(result);
      toast({
        tone: 'success',
        message: t('tickets:toast.unmerged', { reference: ticketReference(result.secondary) }),
      });
    },
    onError: refused,
  });

  const split = useMutation({
    mutationFn: (request: TicketSplitRequest) => api.split(brandId, ticketId, request),
    onSuccess: async (created) => {
      setDialog(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ticketKeys.detail(brandId, ticketId) }),
        queryClient.invalidateQueries({ queryKey: ticketKeys.lists(brandId) }),
        queryClient.invalidateQueries({ queryKey: ticketKeys.counts(brandId) }),
      ]);
      toast({
        tone: 'success',
        message: t('tickets:toast.created', { reference: ticketReference(created.ticket) }),
      });
      onOpenTicket(created.ticket.id);
    },
    onError: refused,
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
      staffName: (userId) => {
        if (userId === null) {
          return null;
        }
        if (userId === viewer.id) {
          return viewer.name;
        }

        return directory.staff.find((member) => member.userId === userId)?.name ?? null;
      },
    }),
    [directory, viewer, contact.data, detail.data],
  );

  const headerViewers = viewers.map(({ userId, activity }) => ({
    name: directory.staff.find((member) => member.userId === userId)?.name ?? userId.slice(0, 8),
    activity,
  }));

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

  const merged = detail.data?.merged ?? [];
  const mergedInto = detail.data?.mergedInto ?? null;
  const items = buildThread(messages, detail.data?.activity ?? [], pending, merged);

  // M1-09's two come first; Log time (M1-12) and Mark as spam (M1-11) follow,
  // in the artboard's order. A merged ticket's state is its primary's, so it
  // offers neither merge nor split: the api would refuse both.
  const mergeActions: readonly TicketAction[] =
    ticket.mergedIntoId === null
      ? [
          {
            id: 'merge',
            label: t('tickets:actions.merge'),
            icon: GitMerge,
            onSelect: () => {
              setMergeTerm('');
              setDialog('merge');
            },
          },
          {
            id: 'split',
            label: t('tickets:actions.split'),
            icon: Split,
            onSelect: () => {
              setDialog('split');
            },
          },
        ]
      : [];
  // The list embeds each ticket's contact (M1-15), so a candidate names its own.
  const candidates = mergeSearch.data?.tickets ?? [];
  const contactName = (id: string | null): string | null => {
    if (id === null) {
      return null;
    }
    const embedded = [ticket, ...candidates].find((row) => row.contact?.id === id)?.contact;

    return embedded?.name ?? (id === contact.data?.id ? contact.data.name : null);
  };
  const agents = assignable.data?.agents ?? [];
  const departmentName = directory.departments.find(
    (department) => department.id === ticket.departmentId,
  )?.name;

  const copyLink = async (link: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      toast({ tone: 'success', message: t('tickets:csat.copied') });
    } catch {
      toast({ tone: 'danger', message: t('tickets:csat.copyFailed') });
    }
  };

  // Paused while the request is out, and reset only once it is logged: a
  // failed log keeps what the timer counted.
  const logTimer = (): void => {
    const seconds = loggableSeconds(timer.seconds);
    if (seconds === null) {
      return;
    }

    timer.pause();
    time.log.mutate(
      { seconds },
      {
        onSuccess: () => {
          timer.take();
        },
      },
    );
  };

  const csat = detail.data?.csat ?? null;
  const cards = (
    <>
      {tracking ? (
        <TimeCard
          entries={time.entries.data}
          failed={time.entries.isError}
          timer={timer}
          viewerId={viewer.id}
          canWrite={canWrite}
          canDeleteAny={role === 'admin' || role === 'teamLeader'}
          busy={time.log.isPending || time.remove.isPending}
          now={now}
          onLogTimer={logTimer}
          onAddManually={() => {
            setLogOpen(true);
          }}
          onDelete={(entry) => {
            time.remove.mutate(entry.id);
          }}
        />
      ) : null}
      {csat === null ? null : (
        <CsatCard
          csat={csat}
          onCopy={(link) => {
            void copyLink(link);
          }}
        />
      )}
    </>
  );

  const logTimeActions: readonly TicketAction[] =
    tracking && canWrite
      ? [
          {
            id: 'log-time',
            label: t('tickets:header.logTime'),
            icon: Clock,
            onSelect: () => {
              setLogOpen(true);
            },
          },
        ]
      : [];

  const details = (
    <DetailsPanel
      ticket={ticket}
      contact={contact.data ?? null}
      hiddenTicketCount={timeline.data?.hiddenCount ?? 0}
      statuses={directory.statuses}
      departments={directory.departments}
      related={detail.data?.related ?? []}
      assignee={{
        name: assigneeName(ticket.assigneeId, { agents, staff: directory.staff, viewer }),
        agents,
        loadCap: assignable.data?.loadCap ?? null,
        unavailable: assignable.isError,
      }}
      now={now}
      busy={update.isPending}
      cards={cards}
      brandTags={directory.tags}
      customFields={ticketFieldsFor(
        fieldDefs.data?.fields ?? [],
        role === 'admin' || role === 'teamLeader',
      )}
      canWrite={canWrite}
      onTagsChange={(tagIds) => {
        tags.mutate(tagIds);
      }}
      onCustomSave={async (key, value) => {
        await saveCustom.mutateAsync({ [key]: value });
      }}
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

    // The timer stops with the send and its time goes with the reply (M1-12).
    const spent = tracking ? loggableSeconds(timer.take()) : null;

    const message: PendingMessage = {
      clientId: crypto.randomUUID(),
      kind: mode === 'note' ? 'note' : 'public',
      bodyHtml: paragraph(text),
      bodyText: text,
      attachmentIds: attachments.map((attachment) => attachment.id),
      ...(spent === null ? {} : { timeSpentSeconds: spent }),
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
          viewers={headerViewers}
          now={now}
          showDetailsButton={detailsInDrawer}
          // One menu (the artboard's panel 2): Merge, Split, Log time, then
          // Mark as spam behind its divider.
          actions={[...mergeActions, ...logTimeActions, ...spam.items]}
          onShowDetails={() => {
            onDetailsOpenChange(true);
          }}
        />

        {/* M1-09: above the thread rather than in it, so "this ticket was
            merged" stays in view however far the thread is scrolled. */}
        {mergedInto === null ? null : (
          <Box sx={{ paddingInline: 5, paddingBlockStart: 4 }}>
            <MergedIntoBanner
              mergedInto={mergedInto}
              names={names}
              now={now}
              busy={unmerge.isPending}
              onUnmerge={() => {
                unmerge.mutate(ticketId);
              }}
            />
          </Box>
        )}

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
            merges={{
              ticketId,
              merged,
              links: visibleLinks(detail.data?.related ?? []),
              busy: unmerge.isPending,
              onUnmerge: (secondaryId) => {
                unmerge.mutate(secondaryId);
              },
            }}
            onRetry={(message) => {
              dispatch({ type: 'retried', clientId: message.clientId, now: Date.now() });
              send.mutate({ ...message, state: 'sending', sentAt: Date.now() });
            }}
            onDiscard={(message) => {
              dispatch({ type: 'discarded', clientId: message.clientId });
            }}
          />
        </Box>

        {mergedInto === null ? (
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
              onBodyFocus={() => {
                if (tracking && timerWithComposer && canWrite && !timer.running) {
                  timer.start();
                }
              }}
            />
          </Box>
        ) : null}
      </Box>

      {spam.dialog}

      <MergeDialog
        open={dialog === 'merge'}
        ticket={ticket}
        candidates={mergeCandidates(candidates, ticket.id)}
        departments={directory.departments}
        contactName={contactName}
        busy={merge.isPending}
        onTermChange={setMergeTerm}
        onSubmit={(primaryTicketId) => {
          merge.mutate(primaryTicketId);
        }}
        onClose={() => {
          setDialog(null);
        }}
      />
      <SplitDialog
        open={dialog === 'split'}
        messages={messages.filter((message) => message.kind !== 'system')}
        departments={directory.departments}
        defaultDepartmentId={ticket.departmentId}
        defaultPriority={ticket.priority}
        authorOf={(message) =>
          names.nameFor(message.authorType, message.authorId) ??
          t(`tickets:thread.${message.authorType === 'staff' ? 'staff' : 'contact'}`)
        }
        now={now}
        busy={split.isPending}
        onSubmit={(request) => {
          split.mutate(request);
        }}
        onClose={() => {
          setDialog(null);
        }}
      />

      <LogTimeDialog
        open={logOpen}
        reference={ticketReference(ticket)}
        viewerName={viewer.name}
        busy={time.log.isPending}
        onClose={() => {
          setLogOpen(false);
        }}
        onSubmit={(request) => {
          time.log.mutate(request, {
            onSuccess: () => {
              setLogOpen(false);
            },
          });
        }}
      />

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
