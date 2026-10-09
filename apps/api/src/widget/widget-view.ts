import type { Attachment as AttachmentRow, TicketMessage as TicketMessageRow } from '@helpdock/db';
import type {
  WidgetAttachment,
  WidgetConversation,
  WidgetConversationHours,
  WidgetMessage,
} from '@helpdock/schemas';
import { readAiMeta, toWidgetMessageAi } from '../ai/auto-reply/ai-meta.js';
import { firstNameOf } from '../csat/csat.service.js';
import type { TicketWithStatus } from './widget.repository.js';

/**
 * Rows as a visitor sees them (DOMAIN-RULES §1.3, layer 4). The shapes have
 * no field for a note, an internal author id, an object key or an agent's
 * surname, so none of them can leak through a response or a socket frame.
 */

const AUTHOR = {
  contact: 'visitor',
  staff: 'agent',
  ai: 'ai',
  system: 'system',
} as const;

export const toWidgetAttachment = (row: AttachmentRow): WidgetAttachment => ({
  id: row.id,
  kind: row.kind,
  name: row.originalName,
  mime: row.mime,
  size: row.size,
  status: row.status,
});

export interface MessageViewOptions {
  /** Staff display names by user id. */
  readonly staffNames: ReadonlyMap<string, string>;
  /** The brand's "Show the agent's name and photo" (M4-08). */
  readonly showAgentIdentity: boolean;
}

export const toWidgetMessage = (
  row: TicketMessageRow,
  files: readonly AttachmentRow[],
  { staffNames, showAgentIdentity }: MessageViewOptions,
): WidgetMessage => {
  const author = AUTHOR[row.authorType];
  const staffName =
    author === 'agent' && row.authorId !== null ? staffNames.get(row.authorId) : undefined;
  const agentName = showAgentIdentity && staffName !== undefined ? firstNameOf(staffName) : null;

  return {
    id: row.id,
    conversationId: row.ticketId,
    seq: row.seq,
    clientId: author === 'visitor' ? row.clientId : null,
    author,
    agent: agentName === null ? null : { name: agentName, avatarUrl: null },
    text: answerOf(row) ?? row.bodyText,
    html: author === 'visitor' || answerOf(row) !== undefined ? null : row.bodyHtml,
    attachments: files.map(toWidgetAttachment),
    ...aiOf(row),
    createdAt: row.createdAt.toISOString(),
  };
};

/** M7-06: an assistant answer's text without the sources list, which the widget draws itself. */
const answerOf = (row: TicketMessageRow): string | undefined =>
  row.authorType === 'ai' ? (readAiMeta(row.aiMeta)?.answer ?? undefined) : undefined;

/** M7-06: an assistant message's sources and the visitor's feedback on it. */
const aiOf = (row: TicketMessageRow): Pick<WidgetMessage, 'ai'> => {
  const ai = row.authorType === 'ai' ? toWidgetMessageAi(row.aiMeta) : undefined;
  return ai === undefined ? {} : { ai };
};

export const toWidgetConversation = (
  { ticket, status }: TicketWithStatus,
  lastSeq: number,
  continuedById: string | null,
  hours: WidgetConversationHours,
): WidgetConversation => ({
  id: ticket.id,
  reference: `${ticket.prefix}-${String(ticket.number)}`,
  subject: ticket.subject,
  state: status.systemState === 'closed' || ticket.mergedIntoId !== null ? 'closed' : 'open',
  channel: ticket.channel,
  lastSeq,
  continuedById,
  aiHandedOff: ticket.aiEligibleAt !== null && ticket.aiPausedAt !== null,
  hours,
  createdAt: ticket.createdAt.toISOString(),
  updatedAt: ticket.updatedAt.toISOString(),
});
