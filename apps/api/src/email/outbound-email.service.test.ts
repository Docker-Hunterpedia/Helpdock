import { describe, expect, it } from 'vitest';
import {
  addressing,
  FakeEmailRepository,
  installSmtp,
  recordingTx,
} from '../testing/email-doubles.js';
import {
  BRAND,
  deliveryRow,
  MESSAGE,
  REFUNDS,
  ROW_A,
  ROW_B,
  ROW_C,
  settingsRow,
  TICKET,
} from '../testing/email-fixtures.js';
import { OutboundEmailService } from './outbound-email.service.js';

const setup = () => {
  const repository = new FakeEmailRepository();
  repository.settingsRow = settingsRow();
  const service = new OutboundEmailService(repository.asRepository, installSmtp());
  return { repository, service, ...recordingTx() };
};

describe('OutboundEmailService.queueReply', () => {
  it("queues the reply as the department's sender, to the contact with CCs copied", async () => {
    const { repository, service, tx, outbox } = setup();

    const delivery = await service.queueReply(tx, {
      brandId: BRAND,
      ticketId: TICKET,
      messageId: MESSAGE,
    });

    expect(delivery).toMatchObject({
      kind: 'reply',
      fromAddress: 'billing@helpdock.io',
      replyTo: 'billing-replies@helpdock.io',
      toAddress: 'mona@example.com',
      ccAddresses: ['karim@acme.de'],
      messageId: `<hd.m.${MESSAGE}@helpdock.io>`,
    });
    expect(outbox).toEqual([{ event: 'email.send', payload: { deliveryId: delivery?.id } }]);
    expect(repository.deliveries).toHaveLength(1);
  });

  it('queues one email for one reply, however often it is asked', async () => {
    const { service, tx, outbox } = setup();
    const input = { brandId: BRAND, ticketId: TICKET, messageId: MESSAGE };

    await service.queueReply(tx, input);
    expect(await service.queueReply(tx, input)).toBeUndefined();

    expect(outbox).toHaveLength(1);
  });

  it('sends nothing to a contact with no address, or from a brand with no sender', async () => {
    const noAddress = setup();
    noAddress.repository.addressingRow = addressing({ contact: null });
    expect(
      await noAddress.service.queueReply(noAddress.tx, {
        brandId: BRAND,
        ticketId: TICKET,
        messageId: MESSAGE,
      }),
    ).toBeUndefined();

    const noSender = setup();
    noSender.repository.settingsRow = undefined;
    expect(
      await noSender.service.queueReply(noSender.tx, {
        brandId: BRAND,
        ticketId: TICKET,
        messageId: MESSAGE,
      }),
    ).toBeUndefined();
    expect([...noAddress.outbox, ...noSender.outbox]).toEqual([]);
  });

  it("goes out as the composer's chosen sender", async () => {
    const { service, tx } = setup();

    const delivery = await service.queueReply(tx, {
      brandId: BRAND,
      ticketId: TICKET,
      messageId: MESSAGE,
      senderKey: 'default',
    });

    expect(delivery?.fromAddress).toBe('support@helpdock.io');
  });
});

describe('OutboundEmailService.queueAutoReply', () => {
  it('addresses the sender, with no CCs, keyed by the ticket', async () => {
    const { service, tx, repository } = setup();
    repository.addressingRow = addressing({ departmentId: REFUNDS });

    const delivery = await service.queueAutoReply(tx, {
      brandId: BRAND,
      ticketId: TICKET,
      kind: 'acknowledgment',
      to: { address: 'karim@acme.de', name: 'Karim' },
    });

    expect(delivery).toMatchObject({
      kind: 'acknowledgment',
      ticketMessageId: null,
      fromAddress: 'support@helpdock.io',
      toAddress: 'karim@acme.de',
      toName: 'Karim',
      ccAddresses: [],
      messageId: `<hd.a.${TICKET}@helpdock.io>`,
    });
  });

  it('queues nothing for a ticket it cannot see', async () => {
    const { service, tx, repository } = setup();
    repository.addressingRow = undefined;

    expect(
      await service.queueAutoReply(tx, {
        brandId: BRAND,
        ticketId: TICKET,
        kind: 'out_of_hours',
        to: { address: 'karim@acme.de' },
      }),
    ).toBeUndefined();
  });
});

describe('OutboundEmailService.retry', () => {
  it('puts failed and discarded sends back and asks for one send each', async () => {
    const { service, tx, repository, outbox } = setup();
    repository.deliveries = [
      deliveryRow({ id: ROW_A, status: 'failed' }),
      deliveryRow({ id: ROW_B, status: 'discarded' }),
      deliveryRow({ id: ROW_C, status: 'sent' }),
    ];

    expect(await service.retry(tx, BRAND, [ROW_A, ROW_B, ROW_C])).toBe(2);
    expect(outbox.map((row) => row.payload.deliveryId)).toEqual([ROW_A, ROW_B]);
    expect(repository.deliveries.find((row) => row.id === ROW_C)?.status).toBe('sent');
  });
});
