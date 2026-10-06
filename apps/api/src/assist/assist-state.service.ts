import { exceededWindow, localeOfLanguage, PiiRedactor, type WindowStatus } from '@helpdock/ai';
import type { DbTransaction } from '@helpdock/db';
import type {
  AssistState,
  DismissSuggestionRequest,
  FieldSuggestions,
  TicketRedactions,
  TicketTranscripts,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { AiRepository } from '../ai/ai.repository.js';
import type { BudgetMeter } from '../ai/budget-meter.js';
import type { AssistRepository } from './assist.repository.js';
import { readAssistModes } from './assist-modes.js';
import { suggestionView } from './assist-views.js';

/**
 * The reads around agent assist that call no model (M7-05, M7-08, M7-09):
 * what the Assist menu and the Suggested fields card open on, "Show
 * redacted", the transcripts under voice notes, and dismissing a suggestion.
 * Each runs in the request's own transaction, under the reader's policy.
 */

/** When a budget window starts again: the next UTC day or month. */
export const resetsAt = (window: Pick<WindowStatus, 'period' | 'periodStart'>): string => {
  const start = new Date(`${window.periodStart}T00:00:00.000Z`);
  if (window.period === 'day') {
    start.setUTCDate(start.getUTCDate() + 1);
  } else {
    start.setUTCMonth(start.getUTCMonth() + 1, 1);
  }
  return start.toISOString();
};

export class AssistStateService {
  readonly #repository: AssistRepository;
  readonly #ai: AiRepository;
  readonly #budget: BudgetMeter;

  constructor(repository: AssistRepository, ai: AiRepository, budget: BudgetMeter) {
    this.#repository = repository;
    this.#ai = ai;
    this.#budget = budget;
  }

  async state(tx: DbTransaction, brandId: string, ticketId: string): Promise<AssistState> {
    const ticket = await this.#requireTicket(tx, ticketId);
    const modes = await readAssistModes(tx, brandId);
    const { windows } = await this.#budget.read(tx, brandId);
    const settings = await this.#ai.settings(tx, brandId);
    const suggestions = await this.#repository.suggestions(tx, ticketId);
    const spent = exceededWindow(windows) !== undefined;

    return {
      enabled: modes.agentAssist,
      blocked: spent && !modes.keepAssistAfterHardStop ? 'budget-exceeded' : null,
      budget: windows
        .filter((window) => window.level !== 'ok')
        .map((window) => ({
          period: window.period,
          level: window.level,
          spentUsd: window.spentUsd,
          limitUsd: window.limitUsd,
          resetsAt: resetsAt(window),
        })),
      keepAssistAfterHardStop: modes.keepAssistAfterHardStop,
      piiRedaction: settings?.piiRedaction ?? true,
      ticketClosed: ticket.closed,
      proposal: (await this.#repository.latestProposal(tx, ticketId)) ?? null,
      suggestions: suggestions === undefined ? null : suggestionView(suggestions),
    };
  }

  /**
   * Each customer message as the model receives it, for "Show redacted". The
   * same redactor `complete()` runs, one per message so its placeholders
   * number from 1 as the agent reads them. Nothing when the brand has turned
   * redaction off: then the model received the message as written.
   */
  async redactions(
    tx: DbTransaction,
    brandId: string,
    ticketId: string,
  ): Promise<TicketRedactions> {
    await this.#requireTicket(tx, ticketId);
    const settings = await this.#ai.settings(tx, brandId);
    if (settings?.piiRedaction === false) {
      return { items: [] };
    }
    const messages = await this.#repository.thread(tx, ticketId);
    return {
      items: messages
        .filter((message) => message.authorType === 'contact')
        .flatMap((message) => {
          const redactor = new PiiRedactor();
          const redactedText = redactor.redact(message.bodyText);
          const { redactions } = redactor;
          return redactions.length === 0
            ? []
            : [
                {
                  messageId: message.id,
                  redactedText,
                  count: redactions.length,
                  kinds: [...new Set(redactions.map((redaction) => redaction.kind))],
                },
              ];
        }),
    };
  }

  async transcripts(tx: DbTransaction, ticketId: string): Promise<TicketTranscripts> {
    await this.#requireTicket(tx, ticketId);
    const rows = await this.#repository.transcripts(tx, ticketId);
    return {
      items: rows.flatMap((row) =>
        row.status === null
          ? []
          : [
              {
                attachmentId: row.id,
                status: row.status,
                text: row.text,
                locale: localeOfLanguage(row.language),
                language: row.language,
              },
            ],
      ),
    };
  }

  /**
   * Takes one field off the card. The agent accepts through the ticket's own
   * endpoints — so an accepted change is audited and evented like any other —
   * and then dismisses it here; a dismissal alone changes nothing.
   */
  async dismiss(
    tx: DbTransaction,
    ticketId: string,
    request: DismissSuggestionRequest,
  ): Promise<FieldSuggestions | null> {
    await this.#requireTicket(tx, ticketId);
    const row = await this.#repository.suggestions(tx, ticketId);
    if (row === undefined) {
      return null;
    }
    const next = {
      tagIds:
        request.field === 'tag'
          ? row.tagIds.filter((id) => request.tagId === undefined || id !== request.tagId)
          : row.tagIds,
      priority: request.field === 'priority' ? null : row.priority,
      suggestedDepartmentId: request.field === 'department' ? null : row.suggestedDepartmentId,
    };
    const updated = await this.#repository.updateSuggestions(tx, row, next);
    return updated === undefined ? null : suggestionView(updated);
  }

  async #requireTicket(tx: DbTransaction, ticketId: string) {
    const ticket = await this.#repository.ticket(tx, ticketId);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }
    return ticket;
  }
}
