import type { DbTransaction } from '@helpdock/db';
import { type MacroLocale, type RenderedMacro, renderSegments } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { getTx } from '../context/request-context.js';
import { templateValues } from '../ticketing/template-render.js';
import type { TemplatesRepository } from '../ticketing/templates.repository.js';
import { type MacrosRepository, readRenderTicket } from './macros.repository.js';
import { bodiesOf } from './macros.service.js';

/**
 * A canned response filled in for one ticket (M3-06).
 *
 * This is the seam M3-03's "send canned response" action calls:
 * `render(id, { locale, ticket })`. It reads what the placeholders need through
 * the caller's transaction — the request's by default, or the worker's when a
 * rule passes its own — so a canned response of another brand, and a ticket
 * the caller cannot read, are both "not found".
 *
 * **The language.** The one asked for, else the contact's, else the brand's
 * default. An empty variant falls back to English (artboard
 * `AdminAutomationMacros`), and the result says so, so the composer can show
 * "Arabic variant empty · English used".
 *
 * **`{{agent.first_name}}`** is whoever sends the reply: the agent at the
 * composer, or — for a rule, which is nobody — the ticket's assignee. With
 * neither it stays spelled out, the same rule as any placeholder that has no
 * value to fill from.
 */

export interface CannedRenderOptions {
  /** Null or absent: the contact's language, then the brand's. */
  readonly locale?: MacroLocale | null | undefined;
  /** The ticket the reply is for. Only its id is read; the rest comes from the database. */
  readonly ticket: { readonly id: string };
  /** Who sends it. Absent: the ticket's assignee. */
  readonly agent?: { readonly id: string } | undefined;
  /** A worker's own transaction. Absent: the request's. */
  readonly tx?: DbTransaction | undefined;
}

export class CannedResponsesService {
  readonly #macros: MacrosRepository;
  readonly #subjects: TemplatesRepository;

  constructor(macros: MacrosRepository, subjects: TemplatesRepository) {
    this.#macros = macros;
    this.#subjects = subjects;
  }

  async render(id: string, options: CannedRenderOptions): Promise<RenderedMacro> {
    const tx = options.tx ?? getTx();

    const row = await this.#macros.find(tx, id);
    if (row === undefined) {
      throw new NotFoundException('No such macro or canned response');
    }

    const ticket = await readRenderTicket(tx, options.ticket.id);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }

    const { brandName, contact } = await this.#subjects.subject(
      tx,
      ticket.brandId,
      ticket.contactId ?? undefined,
    );

    const wanted = options.locale ?? ticket.locale;
    const bodies = bodiesOf(row);
    const fellBack = wanted !== 'en' && bodies[wanted].trim() === '';
    const locale: MacroLocale = fellBack ? 'en' : wanted;
    const agentName =
      options.agent === undefined
        ? ticket.assigneeName
        : await this.#macros.staffName(tx, options.agent.id);

    const { segments, unknown } = renderSegments(
      bodies[locale],
      templateValues({
        brand: { name: brandName },
        contact,
        ticket: { number: ticket.reference },
        agent: agentName === null ? undefined : { name: agentName },
      }),
    );

    return {
      locale,
      fellBack,
      text: segments.map((segment) => segment.text).join(''),
      segments: [...segments],
      unknownPlaceholders: [...unknown],
    };
  }
}
