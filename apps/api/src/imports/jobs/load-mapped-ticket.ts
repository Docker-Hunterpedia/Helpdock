import type { DbTransaction } from '@helpdock/db';
import { type TicketLoad, ticketLoadSchema } from '../loader/contracts.js';
import { resolveTicketMappings } from '../loader/resolve-ticket-mappings.js';
import { type ImportClaim, ImportClaimLost, renewImportClaim } from './claims.js';
import { loadStagedTicket } from './load-ticket-checkpoint.js';

/** Thread/authors are prepared separately; routing and field values come only from confirmed mappings. */
export async function loadMappedStagedTicket(
  tx: DbTransaction,
  request: {
    claim: ImportClaim;
    recordId: string;
    input: Omit<TicketLoad, 'resolved'>;
  },
) {
  if (request.claim.phase !== 'loading') throw new ImportClaimLost();
  await renewImportClaim(tx, request.claim);
  const { brandId, runId, source, record } = request.input;
  const resolved = await resolveTicketMappings(tx, { brandId, runId, source, record });
  const input = ticketLoadSchema.parse({ ...request.input, resolved });
  return loadStagedTicket(tx, { claim: request.claim, recordId: request.recordId, input });
}
