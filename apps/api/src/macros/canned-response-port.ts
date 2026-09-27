import { NotFoundException } from '@nestjs/common';
import type {
  CannedResponseCatalog,
  CannedResponseRenderer,
  RenderedCannedResponse,
} from '../rules/ports.js';
import { paragraphsFrom } from '../ticketing/template-render.js';
import type { CannedResponsesService } from './canned-responses.service.js';

/**
 * M3-06's canned responses in the shape M3-03's rules engine asks for
 * (`rules/ports.ts`), wired in `RulesModule.forRoot` for the builder and in
 * `createRulesEngineDeps` for the worker.
 *
 * The engine passes the whole ticket row and its own transaction; the service
 * reads what the placeholders need through that transaction and signs with the
 * ticket's assignee, since a rule is nobody. Its body is plain text, so it is
 * escaped and wrapped into paragraphs here, as a ticket template is, and the
 * engine sanitises the result again. "No such canned response in this brand"
 * — another brand's, somebody's personal one, deleted since the rule was
 * saved — and an empty reply are `null`, which the engine records as an action
 * it could not carry out.
 */
export const cannedResponsePort = (
  service: CannedResponsesService,
): CannedResponseRenderer & CannedResponseCatalog => ({
  async render(id, { locale, ticket, tx }): Promise<RenderedCannedResponse | null> {
    try {
      const rendered = await service.render(id, { locale, ticket: { id: ticket.id }, tx });
      const bodyHtml = paragraphsFrom(rendered.text);

      return bodyHtml === '' ? null : { bodyHtml };
    } catch (error) {
      if (error instanceof NotFoundException) {
        return null;
      }
      throw error;
    }
  },
  list: (tx) => service.listShared(tx),
});
