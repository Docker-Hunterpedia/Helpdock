import type {
  AttachmentDownloadQuery,
  AttachmentPresignRequest,
  AttachmentPresignResponse,
  WidgetAttachment,
} from '@helpdock/schemas';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import type { MediaRepository } from '../media/media.repository.js';
import type { MediaService } from '../media/media.service.js';
import type { WidgetRepository } from './widget.repository.js';
import type { WidgetConversationsService } from './widget-conversations.service.js';
import { WidgetFailure } from './widget-failure.js';
import type { VisitorScope, WidgetGate, WidgetRequestFacts } from './widget-gate.js';
import { toWidgetAttachment } from './widget-view.js';

/**
 * A visitor's files (M4-07), through M1-10's pipeline unchanged: presign
 * against the brand's content policy, upload straight to the bucket, confirm,
 * and `media.process` sniffs the bytes, re-encodes images to WebP and
 * normalises voice to Opus. The policy is checked at presign, at confirm and
 * again in the worker (ARCHITECTURE §9) — the widget's composer greying a
 * button out is a courtesy, not the rule.
 *
 * The uploader is the visitor (`contact`, visitor id), which is what
 * `linkAttachmentsToMessage` compares when the message is sent: a visitor can
 * attach only what they uploaded.
 *
 * A download is issued only for a file the visitor may see: their own upload,
 * or one on a public reply or AI answer of a conversation they may read —
 * never an internal note's (DOMAIN-RULES §4.5).
 */
export class WidgetUploadsService {
  readonly #gate: WidgetGate;
  readonly #conversations: WidgetConversationsService;
  readonly #media: MediaService;
  readonly #attachments: MediaRepository;
  readonly #widget: WidgetRepository;

  constructor(deps: {
    readonly gate: WidgetGate;
    readonly conversations: WidgetConversationsService;
    readonly media: MediaService;
    readonly attachments: MediaRepository;
    readonly widget: WidgetRepository;
  }) {
    this.#gate = deps.gate;
    this.#conversations = deps.conversations;
    this.#media = deps.media;
    this.#attachments = deps.attachments;
    this.#widget = deps.widget;
  }

  presign(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    input: AttachmentPresignRequest,
  ): Promise<AttachmentPresignResponse> {
    return this.#gate.visitor(brandId, facts, { write: true }, async (scope) => {
      const ticketId = await this.#writable(scope, conversationId);
      return policyRefusals(() =>
        this.#media.presign(brandId, ticketId, visitorPrincipal(scope), input, scope.tx),
      );
    });
  }

  confirm(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    attachmentId: string,
  ): Promise<WidgetAttachment> {
    return this.#gate.visitor(brandId, facts, { write: true }, async (scope) => {
      const ticketId = await this.#writable(scope, conversationId);
      await this.#own(scope, ticketId, attachmentId);
      await policyRefusals(() => this.#media.confirm(brandId, ticketId, attachmentId, scope.tx));
      const row = await this.#attachments.find(scope.tx, attachmentId);
      /* c8 ignore next 3 -- confirmed a moment ago in this transaction. */
      if (row === undefined) {
        throw new WidgetFailure('not_found');
      }
      return toWidgetAttachment(row);
    });
  }

  download(
    brandId: string,
    facts: WidgetRequestFacts,
    conversationId: string,
    attachmentId: string,
    query: AttachmentDownloadQuery,
  ): Promise<{ attachment: WidgetAttachment; url: string; expiresAt: string }> {
    return this.#gate.visitor(brandId, facts, { write: false }, async (scope) => {
      const { ticket } = await this.#conversations.require(scope, conversationId);
      const row = await this.#attachments.find(scope.tx, attachmentId);
      if (row === undefined || row.ticketId !== ticket.id || !(await this.#visible(scope, row))) {
        throw new WidgetFailure('not_found', 'No such attachment');
      }

      try {
        const download = await this.#media.download(
          brandId,
          ticket.id,
          attachmentId,
          query,
          scope.tx,
        );
        return {
          attachment: toWidgetAttachment(row),
          url: download.url,
          expiresAt: download.expiresAt,
        };
      } catch (error) {
        if (error instanceof NotFoundException) {
          throw new WidgetFailure('not_found', error.message);
        }
        if (error instanceof ConflictException) {
          throw new WidgetFailure('read_only', error.message);
        }
        /* c8 ignore next 2 -- download throws nothing else. */
        throw error;
      }
    });
  }

  async #writable(scope: VisitorScope, conversationId: string): Promise<string> {
    const entry = await this.#conversations.require(scope, conversationId);
    if (entry.ticket.channel !== 'chat') {
      throw new WidgetFailure('read_only');
    }
    return entry.ticket.id;
  }

  async #own(scope: VisitorScope, ticketId: string, attachmentId: string): Promise<void> {
    const row = await this.#attachments.find(scope.tx, attachmentId);
    if (
      row === undefined ||
      row.ticketId !== ticketId ||
      row.uploaderType !== 'contact' ||
      row.uploaderId !== scope.visitor.id
    ) {
      throw new WidgetFailure('not_found', 'No such attachment');
    }
  }

  async #visible(
    scope: VisitorScope,
    row: { messageId: string | null; uploaderType: string; uploaderId: string | null },
  ): Promise<boolean> {
    if (row.messageId === null) {
      return row.uploaderType === 'contact' && row.uploaderId === scope.visitor.id;
    }
    const message = await this.#widget.message(scope.tx, row.messageId);
    return message !== undefined && (message.kind === 'public' || message.kind === 'ai');
  }
}

/** The pipeline's uploader identity for a visitor (`media/uploader.ts`). */
const visitorPrincipal = (scope: VisitorScope): Principal => ({
  type: 'visitor',
  id: scope.visitor.id,
  brandId: scope.brand.id,
  conversationIds: [],
});

/** M1-10's refusals, as the widget's `content_policy` so the widget can say which rule. */
const policyRefusals = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof PayloadTooLargeException ||
      error instanceof UnsupportedMediaTypeException ||
      error instanceof BadRequestException
    ) {
      throw new WidgetFailure('content_policy', error.message);
    }
    if (error instanceof NotFoundException) {
      throw new WidgetFailure('not_found', error.message);
    }
    throw error;
  }
};
