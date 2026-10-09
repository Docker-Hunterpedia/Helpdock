import {
  type Ai,
  type AssistLocale,
  type CompleteResult,
  classifyInstructions,
  draftArticleInstructions,
  formatKnowledge,
  formatThread,
  readArticleDraft,
  readClassification,
  readSummary,
  rewriteInstructions,
  suggestReplyInstructions,
  summarizeInstructions,
  type ThreadLine,
  translateInstructions,
  validateCitations,
} from '@helpdock/ai';
import type { Db, DbTransaction } from '@helpdock/db';
import type {
  AssistCallMeta,
  AssistCitation,
  DraftArticleResult,
  RewriteRequest,
  RewriteResult,
  SuggestFieldsResult,
  SuggestReplyResult,
  SummaryResult,
  TranslateRequest,
  TranslateResult,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { BudgetMeter } from '../ai/budget-meter.js';
import type { RetrievedChunk, Retriever } from '../knowledge/retrieval/retrieve.js';
import { inRequestTenant } from '../tenant/step-transactions.js';
import type { AssistRepository, AssistTicket } from './assist.repository.js';
import { AssistFailure, assistFailureOf } from './assist-failure.js';
import { readAssistModes } from './assist-modes.js';
import { suggestionView } from './assist-views.js';
import { conversationLocale, retrievalQuery, threadLines } from './thread-lines.js';

/**
 * Agent assist (M7-05): one model call per request, made between two short
 * transactions under the agent's own tenant context (`@StepTransactions`,
 * ADR 0024) — never inside one, because a model takes seconds.
 *
 * ```
 * step 1  (agent's transaction)  read the ticket under their department policy,
 *                                the brand's assist mode and budget
 * step 2  (no transaction)       retrieve (staff audience) and complete()
 * step 3  (agent's transaction)  only for suggestions: store them
 * ```
 *
 * `complete()` redacts PII before the call and logs it to `ai_calls` with
 * the feature name (`assist.suggest_reply`, …), so nothing here sends a
 * customer's text anywhere unredacted, and every answer can be traced.
 */

/** Chunks a suggested reply is grounded in. */
const REPLY_CONTEXT_CHUNKS = 6;
const MAX_THREAD_CHARS = 24_000;

interface Prepared {
  readonly ticket: AssistTicket;
  readonly lines: readonly ThreadLine[];
  /** The ticket's language: it picks the brand's system prompt for every call. */
  readonly locale: AssistLocale;
  readonly allowOverBudget: boolean;
}

const metaOf = (result: CompleteResult): AssistCallMeta => ({
  callId: result.callId,
  provider: result.provider,
  model: result.model,
  tokensIn: result.tokensIn,
  tokensOut: result.tokensOut,
  costUsd: result.costUsd,
  redactionCount: result.redactions.length,
  redactionKinds: [...new Set(result.redactions.map((redaction) => redaction.kind))],
});

/** The newest messages that fit: a long thread loses its beginning, not its question. */
const threadText = (lines: readonly ThreadLine[]): string => {
  const text = formatThread(lines);
  return text.length <= MAX_THREAD_CHARS ? text : text.slice(text.length - MAX_THREAD_CHARS);
};

const pageOf = (chunk: RetrievedChunk): number | null => {
  const page = chunk.meta.page;
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : null;
};

const citationsOf = (
  answer: string,
  chunks: readonly RetrievedChunk[],
): { text: string; citations: AssistCitation[]; dropped: number } => {
  const check = validateCitations(answer, chunks);
  return {
    text: check.text,
    dropped: check.dropped.length,
    citations: check.citations.flatMap((citation) => {
      const chunk = chunks[citation.marker - 1];
      return chunk === undefined
        ? []
        : [
            {
              marker: citation.marker,
              title: chunk.title,
              sourceKind: chunk.sourceKind,
              visibility: chunk.visibility,
              url: chunk.url,
              articleId: chunk.articleId,
              page: pageOf(chunk),
            },
          ];
    }),
  };
};

export interface AssistServiceDeps {
  readonly db: Db;
  readonly ai: Pick<Ai, 'complete'>;
  readonly retriever: Retriever;
  readonly repository: AssistRepository;
  readonly budget: BudgetMeter;
  readonly now?: () => Date;
}

export class AssistService {
  readonly #deps: AssistServiceDeps;
  readonly #now: () => Date;

  constructor(deps: AssistServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  async suggestReply(brandId: string, ticketId: string): Promise<SuggestReplyResult> {
    const prepared = await this.#prepare(brandId, ticketId, { publicOnly: false });
    if (!prepared.lines.some((line) => line.role === 'customer')) {
      throw new AssistFailure('nothing-to-work-from');
    }
    const { locale } = prepared;
    const { chunks } = await this.#deps.retriever.retrieve({
      brandId,
      query: retrievalQuery(prepared.ticket.subject, prepared.lines),
      audience: 'staff',
      locale,
      k: REPLY_CONTEXT_CHUNKS,
    });
    const result = await this.#complete(prepared, {
      feature: 'assist.suggest_reply',
      instructions: suggestReplyInstructions(locale),
      text: `${formatKnowledge(chunks)}\n\nTicket: ${prepared.ticket.subject}\n\n${threadText(prepared.lines)}`,
      sources: chunks.map((chunk) => ({ chunkId: chunk.chunkId, index: chunk.index })),
    });
    const cited = citationsOf(result.text, chunks);
    return {
      text: cited.text,
      locale,
      citations: cited.citations,
      droppedCitations: cited.dropped,
      meta: metaOf(result),
    };
  }

  async summarize(brandId: string, ticketId: string, locale: AssistLocale): Promise<SummaryResult> {
    const prepared = await this.#prepare(brandId, ticketId, { publicOnly: false });
    const result = await this.#complete(prepared, {
      feature: 'assist.summarize',
      instructions: summarizeInstructions(locale),
      text: `Ticket: ${prepared.ticket.subject}\n\n${threadText(prepared.lines)}`,
    });
    return {
      points: [...this.#read(() => readSummary(result.text))],
      messageCount: prepared.lines.length,
      generatedAt: this.#now().toISOString(),
      meta: metaOf(result),
    };
  }

  async suggestFields(brandId: string, ticketId: string): Promise<SuggestFieldsResult> {
    const prepared = await this.#prepare(brandId, ticketId, { publicOnly: false });
    const options = await inRequestTenant(this.#deps.db, async (tx) => ({
      tags: await this.#deps.repository.tags(tx),
      departments: await this.#deps.repository.departments(tx),
    }));
    const result = await this.#complete(prepared, {
      feature: 'assist.suggest_fields',
      instructions: classifyInstructions({
        ...options,
        fields: ['tags', 'priority', 'department'],
      }),
      text: `Ticket: ${prepared.ticket.subject}\n\n${threadText(prepared.lines)}`,
    });
    const classification = this.#read(() =>
      readClassification(result.text, {
        tagIds: options.tags.map((tag) => tag.id),
        departmentIds: options.departments.map((department) => department.id),
      }),
    );

    const row = await inRequestTenant(this.#deps.db, (tx) =>
      this.#deps.repository.saveSuggestions(tx, {
        brandId,
        ticketId,
        departmentId: prepared.ticket.departmentId,
        tagIds: classification.tagIds,
        priority: classification.priority,
        // Suggesting the department the ticket is already in is no suggestion.
        suggestedDepartmentId:
          classification.departmentId === prepared.ticket.departmentId
            ? null
            : classification.departmentId,
        source: 'assist',
        aiCallId: result.callId,
      }),
    );
    return { suggestions: suggestionView(row), meta: metaOf(result) };
  }

  async translate(
    brandId: string,
    ticketId: string,
    request: TranslateRequest,
  ): Promise<TranslateResult> {
    const prepared = await this.#prepare(brandId, ticketId, { publicOnly: false });
    const source = await this.#translationSource(ticketId, request);
    const result = await this.#complete(prepared, {
      feature: 'assist.translate',
      instructions: translateInstructions(request.target),
      text: source,
    });
    return { text: result.text.trim(), target: request.target, meta: metaOf(result) };
  }

  async rewrite(
    brandId: string,
    ticketId: string,
    request: RewriteRequest,
  ): Promise<RewriteResult> {
    const prepared = await this.#prepare(brandId, ticketId, { publicOnly: false });
    const result = await this.#complete(prepared, {
      feature: 'assist.rewrite',
      instructions: rewriteInstructions(request.tone),
      text: request.text,
    });
    return { text: result.text.trim(), tone: request.tone, meta: metaOf(result) };
  }

  /**
   * From the public messages of a closed ticket, grounded in public knowledge
   * only: an article is for customers, so it may not lean on an internal source.
   */
  async draftArticle(
    brandId: string,
    ticketId: string,
    locale: AssistLocale,
  ): Promise<DraftArticleResult> {
    const prepared = await this.#prepare(brandId, ticketId, { publicOnly: true });
    if (!prepared.ticket.closed) {
      throw new AssistFailure('ticket-not-closed');
    }
    if (prepared.lines.length === 0) {
      throw new AssistFailure('nothing-to-work-from');
    }
    const { chunks } = await this.#deps.retriever.retrieve({
      brandId,
      query: retrievalQuery(prepared.ticket.subject, prepared.lines),
      audience: 'visitor',
      locale,
      k: REPLY_CONTEXT_CHUNKS,
    });
    const result = await this.#complete(prepared, {
      feature: 'assist.draft_article',
      instructions: draftArticleInstructions(locale),
      text: `${formatKnowledge(chunks)}\n\nTicket: ${prepared.ticket.subject}\n\n${threadText(prepared.lines)}`,
      sources: chunks.map((chunk) => ({ chunkId: chunk.chunkId, index: chunk.index })),
    });
    const draft = this.#read(() => readArticleDraft(result.text));
    const cited = citationsOf(draft.body, chunks);
    return {
      title: draft.title,
      bodyMarkdown: cited.text,
      locale,
      messageCount: prepared.lines.length,
      citations: cited.citations,
      meta: metaOf(result),
    };
  }

  /** Step 1: the ticket under the agent's own policy, the brand's mode and its budget. */
  #prepare(
    brandId: string,
    ticketId: string,
    { publicOnly }: { readonly publicOnly: boolean },
  ): Promise<Prepared> {
    return inRequestTenant(this.#deps.db, async (tx: DbTransaction) => {
      const ticket = await this.#deps.repository.ticket(tx, ticketId);
      if (ticket === undefined) {
        throw new NotFoundException('No such ticket');
      }
      const modes = await readAssistModes(tx, brandId);
      if (!modes.agentAssist) {
        throw new AssistFailure('assist-off');
      }
      const reading = await this.#deps.budget.read(tx, brandId);
      const spent = reading.windows.some((window) => window.level === 'exceeded');
      if (spent && !modes.keepAssistAfterHardStop) {
        throw new AssistFailure('budget-exceeded');
      }
      const messages = await this.#deps.repository.thread(tx, ticketId);
      const lines = threadLines(messages, { publicOnly });
      return {
        ticket,
        lines,
        locale: conversationLocale(lines, ticket.locale),
        allowOverBudget: modes.keepAssistAfterHardStop,
      };
    });
  }

  async #translationSource(ticketId: string, request: TranslateRequest): Promise<string> {
    if (request.text !== undefined) {
      return request.text;
    }
    const text = await inRequestTenant(this.#deps.db, async (tx) => {
      if (request.attachmentId !== undefined) {
        return this.#deps.repository.transcriptText(tx, ticketId, request.attachmentId);
      }
      const messages = await this.#deps.repository.thread(tx, ticketId);
      return messages.find((message) => message.id === request.messageId)?.bodyText ?? null;
    });
    if (text === null || text.trim() === '') {
      throw new NotFoundException('Nothing to translate');
    }
    return text;
  }

  /** Step 2: the model, with no transaction open. */
  async #complete(
    prepared: Prepared,
    call: {
      readonly feature: string;
      readonly instructions: string;
      readonly text: string;
      readonly sources?: readonly unknown[];
    },
  ): Promise<CompleteResult> {
    try {
      return await this.#deps.ai.complete({
        brandId: prepared.ticket.brandId,
        ticketId: prepared.ticket.id,
        feature: call.feature,
        locale: prepared.locale,
        instructions: call.instructions,
        messages: [{ role: 'user', text: call.text }],
        allowOverBudget: prepared.allowOverBudget,
        ...(call.sources === undefined ? {} : { sources: call.sources }),
      });
    } catch (error) {
      throw assistFailureOf(error);
    }
  }

  #read<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      throw assistFailureOf(error);
    }
  }
}
