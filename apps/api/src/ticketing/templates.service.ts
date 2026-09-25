import type { DbTransaction, TicketTemplate as TemplateRow } from '@helpdock/db';
import type {
  TicketPriority,
  TicketTemplate,
  TicketTemplateCreateRequest,
  TicketTemplateList,
  TicketTemplatePreview,
  TicketTemplateUpdateRequest,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { leadsDepartment } from '../brands/department-scope.js';
import { TicketingFailure } from '../brands/ticketing-failure.js';
import { writeTicketingAudit } from './audit.js';
import { parseCustomValues } from './custom-values.js';
import type { TagsService } from './tags.service.js';
import { renderTemplate, templateValues } from './template-render.js';
import type { TemplatesRepository } from './templates.repository.js';
import type { TicketingContext } from './ticketing-context.js';

/**
 * Ticket templates (M1-06), the Templates tab of the Ticketing settings screen.
 *
 * **A template is data, never behaviour.** It holds a subject, a body, a
 * priority, a department, some tags and some custom values, and `POST /tickets`
 * applies them. There is nothing here a template can *do*, which is what keeps
 * `{{contact.first_name}}` a lookup in a fixed table rather than an expression
 * language (`template-render.ts` says why that matters).
 *
 * **A Team Leader stays inside their departments.** A template names the
 * department its tickets are filed in, and DOMAIN-RULES §1.2 gives a Team
 * Leader "departments they lead". A template with no department is brand-wide
 * and, like a tag, is open to anybody holding `ticketing:manage`.
 */
/** A template, rendered for one ticket, as `POST /tickets` consumes it. */
export interface AppliedTemplate {
  readonly subject: string;
  readonly bodyText: string;
  readonly departmentId: string | null;
  readonly priority: TicketPriority;
  readonly defaultTagIds: readonly string[];
  readonly customDefaults: Record<string, unknown>;
}

export class TemplatesService {
  readonly #repository: TemplatesRepository;
  readonly #tags: TagsService;

  constructor(repository: TemplatesRepository, tags: TagsService) {
    this.#repository = repository;
    this.#tags = tags;
  }

  /**
   * Readable by anybody who may write a ticket: the picker on the create screen
   * is this list. Tags the brand has since deleted are filtered out of every
   * template's defaults on the way out, so a template never offers a chip that
   * no longer exists.
   */
  async list(tx: DbTransaction): Promise<TicketTemplateList> {
    const rows = await this.#repository.list(tx);
    const live = await this.#liveTagIds(tx, rows);

    return { templates: rows.map((row) => toTemplate(row, live)) };
  }

  async find(tx: DbTransaction, templateId: string): Promise<TicketTemplate> {
    const row = await this.#require(tx, templateId);

    return toTemplate(row, await this.#liveTagIds(tx, [row]));
  }

  /**
   * The template with its placeholders filled. A read: nothing is written and
   * no ticket exists yet, so `{{ticket.number}}` has no value and stays spelled
   * out — which is also what the editor needs to show.
   */
  async preview(
    tx: DbTransaction,
    brandId: string,
    templateId: string,
    contactId: string | undefined,
  ): Promise<TicketTemplatePreview> {
    const template = await this.#require(tx, templateId);
    const { brandName, contact } = await this.#repository.subject(tx, brandId, contactId);

    const values = templateValues({ brand: { name: brandName }, contact });
    const subject = renderTemplate(template.subject, values);
    const body = renderTemplate(template.bodyText, values);

    return {
      subject: subject.text,
      bodyText: body.text,
      unknownPlaceholders: [...new Set([...subject.unknown, ...body.unknown])],
    };
  }

  async create(
    context: TicketingContext,
    request: TicketTemplateCreateRequest,
  ): Promise<TicketTemplate> {
    const departmentId = request.departmentId ?? null;
    this.#assertDepartment(context, departmentId);
    await this.#assertNameFree(context.tx, request.name);
    await this.#assertTagsExist(context.tx, request.defaultTagIds);
    const customDefaults = await this.#validDefaults(context.tx, request.customDefaults);

    const created = await this.#repository.create(context.tx, {
      brandId: context.brandId,
      name: request.name,
      departmentId,
      priority: request.priority,
      subject: request.subject,
      bodyText: request.bodyText,
      defaultTagIds: [...request.defaultTagIds],
      customDefaults,
    });

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'ticket_template.created',
      targetType: 'ticket_template',
      targetId: created.id,
      meta: { name: created.name, departmentId },
    });

    return toTemplate(created, new Set(created.defaultTagIds));
  }

  async update(
    context: TicketingContext,
    templateId: string,
    request: TicketTemplateUpdateRequest,
  ): Promise<TicketTemplate> {
    const template = await this.#require(context.tx, templateId);

    // Both ends of a move: a leader may not take a template out of a department
    // they do not lead, nor put one into one.
    this.#assertDepartment(context, template.departmentId);
    if (request.departmentId !== undefined) {
      this.#assertDepartment(context, request.departmentId);
    }

    if (request.name !== undefined && !sameName(request.name, template.name)) {
      await this.#assertNameFree(context.tx, request.name, templateId);
    }
    if (request.defaultTagIds !== undefined) {
      await this.#assertTagsExist(context.tx, request.defaultTagIds);
    }
    const customDefaults =
      request.customDefaults === undefined
        ? undefined
        : await this.#validDefaults(context.tx, request.customDefaults);

    await this.#repository.update(context.tx, templateId, {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.departmentId === undefined ? {} : { departmentId: request.departmentId }),
      ...(request.priority === undefined ? {} : { priority: request.priority }),
      ...(request.subject === undefined ? {} : { subject: request.subject }),
      ...(request.bodyText === undefined ? {} : { bodyText: request.bodyText }),
      ...(request.defaultTagIds === undefined ? {} : { defaultTagIds: [...request.defaultTagIds] }),
      ...(customDefaults === undefined ? {} : { customDefaults }),
    });

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'ticket_template.updated',
      targetType: 'ticket_template',
      targetId: templateId,
      meta: {
        name: request.name ?? template.name,
        ...(request.departmentId === undefined
          ? {}
          : { departmentId: request.departmentId, wasDepartmentId: template.departmentId }),
      },
    });

    return this.find(context.tx, templateId);
  }

  async remove(context: TicketingContext, templateId: string): Promise<void> {
    const template = await this.#require(context.tx, templateId);
    this.#assertDepartment(context, template.departmentId);

    await this.#repository.delete(context.tx, templateId);

    await writeTicketingAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'ticket_template.deleted',
      targetType: 'ticket_template',
      targetId: templateId,
      meta: { name: template.name, usageCount: template.usageCount },
    });
  }

  /**
   * The stored row, or a 404. `POST /tickets` reads it before it validates,
   * because the department and the priority it is about to check may be the
   * template's.
   */
  row(tx: DbTransaction, templateId: string): Promise<TemplateRow> {
    return this.#require(tx, templateId);
  }

  /**
   * The template filled in for a ticket that is about to be written, and one
   * more on its counter.
   *
   * The counter is bumped here rather than by the caller so that "a ticket was
   * made from this" cannot be recorded without the template having been
   * applied, and both happen in the transaction that writes the ticket — a
   * creation that rolls back takes the count with it.
   *
   * Tags the brand has since deleted are dropped rather than refused: a
   * template is not broken by somebody tidying the tag list, and the ticket
   * being filed is not the moment to say so.
   */
  async apply(
    tx: DbTransaction,
    template: TemplateRow,
    subject: { readonly brandId: string; readonly contactId?: string; readonly number: string },
  ): Promise<AppliedTemplate> {
    const { brandName, contact } = await this.#repository.subject(
      tx,
      subject.brandId,
      subject.contactId,
    );

    const values = templateValues({
      brand: { name: brandName },
      contact,
      ticket: { number: subject.number },
    });

    await this.#repository.recordUse(tx, template.id);
    const live = await this.#liveTagIds(tx, [template]);

    return {
      subject: renderTemplate(template.subject, values).text,
      bodyText: renderTemplate(template.bodyText, values).text,
      departmentId: template.departmentId,
      priority: template.priority,
      defaultTagIds: template.defaultTagIds.filter((id) => live.has(id)),
      customDefaults: template.customDefaults,
    };
  }

  // ------------------------------------------------------------------

  async #require(tx: DbTransaction, templateId: string): Promise<TemplateRow> {
    const template = await this.#repository.find(tx, templateId);
    if (template === undefined) {
      throw new NotFoundException('No such ticket template');
    }

    return template;
  }

  #assertDepartment(context: TicketingContext, departmentId: string | null): void {
    if (departmentId === null) {
      return;
    }
    if (!leadsDepartment(context.actor, departmentId)) {
      throw new TicketingFailure('out-of-scope');
    }
  }

  async #assertNameFree(tx: DbTransaction, name: string, exceptId?: string): Promise<void> {
    const taken = await this.#repository.nameTaken(
      tx,
      name,
      exceptId === undefined ? {} : { exceptId },
    );
    if (taken) {
      throw new TicketingFailure('name-taken');
    }
  }

  /**
   * The defaults, checked against the brand's *ticket* definitions and returned
   * coerced — `"12"` stored as `12`, a date-time cut to its day.
   *
   * Checked **here**, when the template is written, rather than only when a
   * ticket is filed from it: a default that no field accepts would otherwise
   * make every ticket created from the template a 400, and the person who
   * could fix it is the one saving the template. `partial`, because a template
   * is not obliged to fill a required field — the person filing the ticket is.
   */
  async #validDefaults(
    tx: DbTransaction,
    defaults: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return (await parseCustomValues(tx, 'ticket', defaults, { partial: true })) ?? {};
  }

  /**
   * A default tag has to be one of this brand's. The column is a `uuid[]` with
   * no foreign key — arrays cannot have one — so this is the whole check.
   */
  async #assertTagsExist(tx: DbTransaction, tagIds: readonly string[]): Promise<void> {
    const unknown = await this.#tags.unknownIds(tx, tagIds);
    if (unknown.length > 0) {
      throw new NotFoundException('No such tag in this brand');
    }
  }

  /** Which of the tag ids these templates name still exist. */
  async #liveTagIds(tx: DbTransaction, rows: readonly TemplateRow[]): Promise<Set<string>> {
    const named = [...new Set(rows.flatMap((row) => row.defaultTagIds))];
    const unknown = new Set(await this.#tags.unknownIds(tx, named));

    return new Set(named.filter((id) => !unknown.has(id)));
  }
}

const sameName = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const toTemplate = (row: TemplateRow, liveTagIds: ReadonlySet<string>): TicketTemplate => ({
  id: row.id,
  name: row.name,
  departmentId: row.departmentId,
  priority: row.priority,
  subject: row.subject,
  bodyText: row.bodyText,
  defaultTagIds: row.defaultTagIds.filter((id) => liveTagIds.has(id)),
  customDefaults: row.customDefaults,
  usageCount: row.usageCount,
});
