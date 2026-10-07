import { type DbTransaction, outbox } from '@helpdock/db';
import { createOutboxDispatcher, silentLogger } from '@helpdock/jobs';
import { describe, expect, it } from 'vitest';
import {
  CONTACT_CREATED_EVENT,
  enqueueContactCreated,
  registerContactEventHandlers,
} from './contact-events.js';

const BRAND = '0192a000-0000-7000-8000-0000000000b1';
const CONTACT = '0192a000-0000-7000-8000-0000000000c1';

describe('contact.created', () => {
  it('is written to the outbox with the contact id and nothing else', async () => {
    const written: { table: unknown; values: unknown }[] = [];
    const tx = {
      insert: (table: unknown) => ({
        values: (values: unknown) => ({
          returning: async () => {
            written.push({ table, values });
            return [{ id: 'outbox-row' }];
          },
        }),
      }),
    } as unknown as DbTransaction;

    await expect(enqueueContactCreated(tx, BRAND, CONTACT)).resolves.toBe('outbox-row');
    expect(written).toEqual([
      {
        table: outbox,
        values: { brandId: BRAND, event: CONTACT_CREATED_EVENT, payload: { contactId: CONTACT } },
      },
    ]);
  });

  it('has an owner, so a brand with no webhook does not fail the event as unknown', async () => {
    const dispatcher = createOutboxDispatcher();
    registerContactEventHandlers(dispatcher);

    await expect(
      dispatcher.dispatch({
        outboxId: 'outbox-row',
        brandId: BRAND,
        event: CONTACT_CREATED_EVENT,
        payload: { contactId: CONTACT },
        tx: {} as DbTransaction,
        log: silentLogger,
      }),
    ).resolves.toBeUndefined();
  });
});
