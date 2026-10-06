import type {
  AssistTone,
  Department,
  DraftArticleResult,
  FieldSuggestions,
  ProposalCreateRequest,
  RewriteResult,
  SuggestReplyResult,
  SummaryResult,
  TagSummary,
  Ticket,
  TicketMessage,
  TicketPriority,
  TicketUpdateRequest,
  TranslateResult,
} from '@helpdock/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { helpCenterRoute } from '../../../app/route-paths.js';
import { assistKeys, isAssistError } from '../../../assist/api.js';
import { useAssistApi } from '../../../assist/context.tsx';
import { helpCenterKeys } from '../../../help-center/api.js';
import { useHelpCenterApi } from '../../../help-center/context.tsx';
import { useToast } from '../../../ui/toasts.tsx';
import type { ThreadAssist } from '../thread.tsx';
import { AssistLogDisclosure } from './ai-log-disclosure.tsx';
import { AISuggestionCard } from './ai-suggestion-card.tsx';
import { type AssistAction, AssistMenu } from './assist-menu.tsx';
import { AssistCitationList } from './citation-list.tsx';
import { DraftArticleDialog } from './draft-article-dialog.tsx';
import { insertableReply, textLocale } from './format.js';
import { MessageAiFacts, RedactedText, TranslatedText } from './message-ai-facts.tsx';
import { SuggestedFieldsCard, type SuggestedRow, suggestedRows } from './suggested-fields-card.tsx';
import { SummaryCard } from './summary-card.tsx';
import { ToneChips } from './tone-chips.tsx';
import type { TranscriptsValue } from './voice-transcript.tsx';

/**
 * Agent assist on one ticket (M7-05, M7-08, M7-09; `Admin/Ticket-AI`), in one
 * hook so the ticket view only places what it returns: the Assist menu and
 * the card above the composer, the summary over the thread, the Suggested
 * fields card in the details panel, the translation and "Show redacted" lines
 * under a customer's messages, the transcripts under voice notes, and the
 * "Draft article" dialog. A Viewer gets the transcripts alone.
 */

/** What waits above the composer text: one at a time, the newest wins. */
type ComposerCard =
  | { readonly kind: 'reply'; readonly result: SuggestReplyResult }
  | {
      readonly kind: 'rewrite';
      /** The agent's own text, which a new tone reruns on. */
      readonly original: string;
      readonly result: RewriteResult;
    }
  | { readonly kind: 'translation'; readonly result: TranslateResult };

interface MessageView {
  readonly translation?: string;
  readonly translationLocale?: 'en' | 'ar';
  readonly showOriginal?: boolean;
  readonly showRedacted?: boolean;
}

const TRANSCRIPT_POLL_MS = 5_000;

export interface TicketAssistInput {
  readonly brandId: string;
  readonly ticketId: string;
  /** Undefined while the ticket is being read; nothing is drawn until it is. */
  readonly ticket: Ticket | undefined;
  readonly reference: string;
  readonly canWrite: boolean;
  readonly mode: 'reply' | 'note';
  readonly body: string;
  setBody(body: string): void;
  /** The customer's language, which "Translate reply" translates into. */
  readonly contactLocale: 'en' | 'ar';
  readonly tags: readonly TagSummary[];
  readonly departments: readonly Department[];
  updateTicket(patch: TicketUpdateRequest): Promise<unknown>;
  setTags(tagIds: readonly string[]): Promise<unknown>;
}

export interface TicketAssist {
  readonly menu: ReactNode;
  readonly composerCard: ReactNode;
  readonly summary: ReactNode;
  readonly fieldsCard: ReactNode;
  readonly thread: ThreadAssist;
  readonly transcripts: TranscriptsValue;
  readonly dialog: ReactNode;
}

export function useTicketAssist(input: TicketAssistInput): TicketAssist {
  const { brandId, ticketId, ticket, canWrite } = input;
  const t = useT();
  const { locale } = usePreferences();
  const api = useAssistApi();
  const helpCenter = useHelpCenterApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const [card, setCard] = useState<ComposerCard | null>(null);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [views, setViews] = useState<ReadonlyMap<string, MessageView>>(new Map());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<DraftArticleResult | null>(null);

  const state = useQuery({
    queryKey: assistKeys.state(brandId, ticketId),
    queryFn: () => api.state(brandId, ticketId),
    enabled: canWrite && ticket !== undefined,
  });
  const enabled = state.data?.enabled === true;
  const redactions = useQuery({
    queryKey: assistKeys.redactions(brandId, ticketId),
    queryFn: () => api.redactions(brandId, ticketId),
    enabled,
  });
  const transcripts = useQuery({
    queryKey: assistKeys.transcripts(brandId, ticketId),
    queryFn: () => api.transcripts(brandId, ticketId),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'pending') === true
        ? TRANSCRIPT_POLL_MS
        : false,
  });
  const structure = useQuery({
    queryKey: helpCenterKeys.structure(brandId),
    queryFn: () => helpCenter.structure(brandId),
    enabled: dialogOpen,
  });

  const failed = (error: unknown): void => {
    toast({
      tone: 'danger',
      message: isAssistError(error)
        ? t(`tickets:assist.failed.${error.reason}`)
        : t('tickets:assist.failed.generic'),
    });
  };
  const refreshState = () =>
    queryClient.invalidateQueries({ queryKey: assistKeys.state(brandId, ticketId) });

  const suggestReply = useMutation({
    mutationFn: () => api.suggestReply(brandId, ticketId),
    onSuccess: (result) => {
      setCard({ kind: 'reply', result });
    },
    onError: failed,
  });
  const summarize = useMutation({
    mutationFn: () => api.summarize(brandId, ticketId, locale),
    onSuccess: setSummary,
    onError: failed,
  });
  const suggestFields = useMutation({
    mutationFn: () => api.suggestFields(brandId, ticketId),
    onSuccess: refreshState,
    onError: failed,
  });
  const rewrite = useMutation({
    mutationFn: ({ text, tone }: { text: string; tone: AssistTone }) =>
      api.rewrite(brandId, ticketId, { text, tone }),
    onSuccess: (result, { text }) => {
      setCard({ kind: 'rewrite', original: text, result });
    },
    onError: failed,
  });
  const translateDraft = useMutation({
    mutationFn: (target: 'en' | 'ar') =>
      api.translate(brandId, ticketId, { text: input.body, target }),
    onSuccess: (result) => {
      setCard({ kind: 'translation', result });
    },
    onError: failed,
  });
  const translateMessage = useMutation({
    mutationFn: ({ messageId, target }: { messageId: string; target: 'en' | 'ar' }) =>
      api.translate(brandId, ticketId, { messageId, target }),
    onSuccess: (result, { messageId }) => {
      setViews((held) =>
        new Map(held).set(messageId, {
          ...held.get(messageId),
          translation: result.text,
          translationLocale: result.target,
          showOriginal: false,
        }),
      );
    },
    onError: failed,
  });
  const draftArticle = useMutation({
    mutationFn: (draftLocale: 'en' | 'ar') => api.draftArticle(brandId, ticketId, draftLocale),
    onSuccess: setDraft,
    onError: failed,
  });
  const propose = useMutation({
    mutationFn: (request: ProposalCreateRequest) => api.propose(brandId, ticketId, request),
    onSuccess: async () => {
      setDialogOpen(false);
      setDraft(null);
      toast({ tone: 'success', message: t('tickets:assist.draft.sent') });
      await refreshState();
    },
    onError: failed,
  });
  const dismiss = useMutation({
    mutationFn: (row: SuggestedRow) =>
      api.dismissSuggestion(
        brandId,
        ticketId,
        row.target.field === 'tag'
          ? { field: 'tag', tagId: row.target.tagId }
          : { field: row.target.field },
      ),
    onSuccess: refreshState,
    onError: failed,
  });

  const busy =
    suggestReply.isPending ||
    summarize.isPending ||
    suggestFields.isPending ||
    rewrite.isPending ||
    translateDraft.isPending;

  const select = (action: AssistAction): void => {
    switch (action.kind) {
      case 'suggest-reply':
        suggestReply.mutate();
        return;
      case 'summarize':
        summarize.mutate();
        return;
      case 'suggest-fields':
        suggestFields.mutate();
        return;
      case 'translate-reply':
        translateDraft.mutate(action.target);
        return;
      case 'rewrite':
        rewrite.mutate({ text: input.body, tone: action.tone });
        return;
      case 'draft-article':
        setDraft(null);
        setDialogOpen(true);
        draftArticle.mutate(input.contactLocale);
        return;
    }
  };

  /** Accepting goes through the ticket's own endpoints, then the field leaves the card. */
  const accept = async (row: SuggestedRow): Promise<void> => {
    if (row.target.field === 'tag') {
      await input.setTags([...(ticket?.tags ?? []).map((tag) => tag.id), row.target.tagId]);
    } else if (row.target.field === 'priority') {
      const priority = state.data?.suggestions?.priority;
      if (priority !== undefined && priority !== null) {
        await input.updateTicket({ priority });
      }
    } else {
      const departmentId = state.data?.suggestions?.departmentId;
      if (departmentId !== undefined && departmentId !== null) {
        await input.updateTicket({ departmentId });
      }
    }
    dismiss.mutate(row);
  };

  const rows = useMemo(
    () =>
      suggestionRows(state.data?.suggestions, {
        tags: input.tags,
        departments: input.departments,
        ticket,
        locale,
        priorityName: (priority) => t(`tickets:priority.${priority}`),
        labels: {
          tag: t('tickets:assist.fields.tag'),
          priority: t('tickets:assist.fields.priority'),
          department: t('tickets:assist.fields.department'),
        },
      }),
    [state.data?.suggestions, input.tags, input.departments, ticket, locale, t],
  );

  const setView = (messageId: string, patch: MessageView): void => {
    setViews((held) => new Map(held).set(messageId, { ...held.get(messageId), ...patch }));
  };

  const thread: ThreadAssist = {
    brandId,
    bodyFor: (message) => {
      const view = views.get(message.id);
      const redaction = redactions.data?.items.find((item) => item.messageId === message.id);
      if (view?.showRedacted === true && redaction !== undefined) {
        return <RedactedText text={redaction.redactedText} />;
      }
      if (view?.translation !== undefined && view.showOriginal !== true) {
        return <TranslatedText text={view.translation} locale={view.translationLocale ?? 'en'} />;
      }
      return undefined;
    },
    factsFor: (message) =>
      enabled && message.authorType === 'contact' ? (
        <MessageFacts
          message={message}
          view={views.get(message.id)}
          redactionCount={
            redactions.data?.items.find((item) => item.messageId === message.id)?.count
          }
          agentLocale={locale}
          busy={translateMessage.isPending}
          onTranslate={(target) => {
            translateMessage.mutate({ messageId: message.id, target });
          }}
          onView={(patch) => {
            setView(message.id, patch);
          }}
        />
      ) : undefined,
  };

  const composerCard = ((): ReactNode => {
    if (card === null) {
      return null;
    }
    const discard = () => {
      setCard(null);
    };
    switch (card.kind) {
      case 'reply':
        return (
          <AISuggestionCard
            title={t('tickets:assist.reply.title')}
            caption={t('tickets:assist.reply.caption', {
              language: t(`tickets:assist.languages.${card.result.locale}`),
              count: card.result.citations.length,
            })}
            lang={card.result.locale}
            text={card.result.text}
            acceptLabel={t('tickets:assist.reply.insert')}
            discardLabel={t('tickets:assist.discard')}
            onDiscard={discard}
            onAccept={() => {
              const inserted = insertableReply(card.result, input.mode);
              input.setBody(input.body.trim() === '' ? inserted : `${input.body}\n\n${inserted}`);
              setCard(null);
            }}
          >
            <AssistCitationList citations={card.result.citations} size={12} />
            <AssistLogDisclosure meta={card.result.meta} />
          </AISuggestionCard>
        );
      case 'rewrite':
        return (
          <AISuggestionCard
            title={t('tickets:assist.rewrite.title')}
            lang={textLocale(card.result.text)}
            text={card.result.text}
            acceptLabel={t('tickets:assist.rewrite.replace')}
            discardLabel={t('tickets:assist.rewrite.keep')}
            onDiscard={discard}
            onAccept={() => {
              input.setBody(card.result.text);
              setCard(null);
            }}
            before={
              <ToneChips
                tone={card.result.tone}
                busy={rewrite.isPending}
                onTone={(tone) => {
                  rewrite.mutate({ text: card.original, tone });
                }}
              />
            }
          >
            <AssistLogDisclosure meta={card.result.meta} />
          </AISuggestionCard>
        );
      case 'translation':
        return (
          <AISuggestionCard
            title={t('tickets:assist.translation.title', {
              language: t(`tickets:assist.languages.${card.result.target}`),
            })}
            lang={card.result.target}
            text={card.result.text}
            acceptLabel={t('tickets:assist.rewrite.replace')}
            discardLabel={t('tickets:assist.rewrite.keep')}
            onDiscard={discard}
            onAccept={() => {
              input.setBody(card.result.text);
              setCard(null);
            }}
          >
            <AssistLogDisclosure meta={card.result.meta} />
          </AISuggestionCard>
        );
    }
  })();

  return {
    menu:
      enabled && state.data !== undefined ? (
        <AssistMenu
          state={state.data}
          draft={input.body}
          translateTarget={input.contactLocale}
          busy={busy}
          onSelect={select}
          onViewProposal={() => {
            void navigate(
              `${helpCenterRoute('proposals')}?proposal=${state.data?.proposal?.id ?? ''}`,
            );
          }}
        />
      ) : null,
    composerCard,
    summary:
      summary === null ? null : (
        <SummaryCard
          summary={summary}
          busy={summarize.isPending}
          onRefresh={() => {
            summarize.mutate();
          }}
          onHide={() => {
            setSummary(null);
          }}
        />
      ),
    fieldsCard:
      enabled && rows.length > 0 ? (
        <SuggestedFieldsCard
          rows={rows}
          busy={dismiss.isPending}
          onAccept={(row) => {
            accept(row).catch(failed);
          }}
          onDismiss={(row) => {
            dismiss.mutate(row);
          }}
          onAcceptAll={() => {
            (async () => {
              for (const row of rows) {
                await accept(row);
              }
            })().catch(failed);
          }}
        />
      ) : null,
    thread,
    transcripts: {
      transcriptOf: (attachmentId) =>
        transcripts.data?.items.find((item) => item.attachmentId === attachmentId),
      translate: async (attachmentId, target) =>
        (await api.translate(brandId, ticketId, { attachmentId, target })).text,
    },
    dialog: (
      <DraftArticleDialog
        open={dialogOpen}
        reference={input.reference}
        structure={structure.data}
        draft={draft}
        drafting={draftArticle.isPending}
        sending={propose.isPending}
        onDraft={(draftLocale) => {
          setDraft(null);
          draftArticle.mutate(draftLocale);
        }}
        onSend={(request) => {
          propose.mutate(request);
        }}
        onClose={() => {
          setDialogOpen(false);
        }}
      />
    ),
  };
}

const suggestionRows = (
  suggestions: FieldSuggestions | null | undefined,
  {
    tags,
    departments,
    ticket,
    locale,
    priorityName,
    labels,
  }: {
    readonly tags: readonly TagSummary[];
    readonly departments: readonly Department[];
    readonly ticket: Ticket | undefined;
    readonly locale: 'en' | 'ar';
    readonly priorityName: (priority: TicketPriority) => string;
    readonly labels: { tag: string; priority: string; department: string };
  },
): SuggestedRow[] => {
  if (suggestions === null || suggestions === undefined || ticket === undefined) {
    return [];
  }
  const onTicket = new Set((ticket.tags ?? []).map((tag) => tag.id));
  return suggestedRows(
    { ...suggestions, tagIds: suggestions.tagIds.filter((id) => !onTicket.has(id)) },
    {
      tagName: (id) => {
        const tag = tags.find((candidate) => candidate.id === id);
        return tag === undefined
          ? undefined
          : locale === 'ar' && tag.nameAr
            ? tag.nameAr
            : tag.name;
      },
      departmentName: (id) => {
        return departments.find((candidate) => candidate.id === id)?.name;
      },
      priorityName,
      current: { priority: ticket.priority, departmentId: ticket.departmentId },
    },
    labels,
  );
};

function MessageFacts({
  message,
  view,
  redactionCount,
  agentLocale,
  busy,
  onTranslate,
  onView,
}: {
  readonly message: TicketMessage;
  readonly view: MessageView | undefined;
  readonly redactionCount: number | undefined;
  readonly agentLocale: 'en' | 'ar';
  readonly busy: boolean;
  onTranslate(target: 'en' | 'ar'): void;
  onView(patch: MessageView): void;
}): ReactNode {
  const written = textLocale(message.bodyText);
  return (
    <MessageAiFacts
      translation={
        written === agentLocale
          ? undefined
          : {
              from: written,
              state:
                view?.translation === undefined
                  ? 'none'
                  : view.showOriginal === true
                    ? 'original'
                    : 'translated',
              busy,
              onTranslate: () => {
                onTranslate(agentLocale);
              },
              onToggleOriginal: () => {
                onView({ showOriginal: view?.showOriginal !== true, showRedacted: false });
              },
            }
      }
      redaction={
        redactionCount === undefined
          ? undefined
          : {
              count: redactionCount,
              shown: view?.showRedacted === true,
              onToggle: () => {
                onView({ showRedacted: view?.showRedacted !== true });
              },
            }
      }
    />
  );
}
