import {
  csatOriginalAnswerSchema,
  type TicketActivityEntry,
  ticketCsatSchema,
} from '@helpdock/schemas';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { CsatCard } from './csat-card.js';

/** Imported history may be read, never turned into a shareable survey. */
export function ImportedCsatEvent({ entry }: { readonly entry: TicketActivityEntry }): ReactNode {
  if (entry.action !== 'ticket.imported.event') return null;
  const csat = ticketCsatSchema.safeParse(entry.to?.csat);
  if (
    !csat.success ||
    csat.data.link !== null ||
    !['rated', 'imported_unscored'].includes(csat.data.state)
  )
    return null;
  const original = z
    .object({ details: z.object({ originalAnswers: z.array(csatOriginalAnswerSchema).max(1000) }) })
    .safeParse(entry.to?.sourceEvent);
  return (
    <CsatCard
      csat={{
        ...csat.data,
        ...(csat.data.originalAnswers === undefined && original.success
          ? { originalAnswers: original.data.details.originalAnswers }
          : {}),
      }}
      onCopy={() => {}}
    />
  );
}
