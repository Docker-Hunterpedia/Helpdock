import type { DbTransaction, Ticket } from '@helpdock/db';
import type { RenderedMacro } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { cannedResponsePort } from './canned-response-port.js';
import type { CannedResponsesService } from './canned-responses.service.js';

const tx = {} as DbTransaction;
const ticket = { id: 'ticket-1' } as Ticket;

const rendered = (text: string): RenderedMacro => ({
  locale: 'en',
  fellBack: false,
  text,
  segments: [{ text, placeholder: null }],
  unknownPlaceholders: [],
});

const serviceWith = (
  render: CannedResponsesService['render'],
): { service: CannedResponsesService; render: ReturnType<typeof vi.fn> } => {
  const spy = vi.fn(render);
  const service = {
    render: spy,
    listShared: vi.fn(() => Promise.resolve([{ id: 'canned-1', name: 'Refund received' }])),
  } as unknown as CannedResponsesService;
  return { service, render: spy };
};

describe('cannedResponsePort', () => {
  it('renders through the engine’s transaction, for the ticket, in the asked language', async () => {
    const { service, render } = serviceWith(() => Promise.resolve(rendered('Refund received')));

    const result = await cannedResponsePort(service).render('canned-1', {
      locale: 'ar',
      ticket,
      tx,
    });

    expect(render).toHaveBeenCalledWith('canned-1', {
      locale: 'ar',
      ticket: { id: 'ticket-1' },
      tx,
    });
    expect(result).toEqual({ bodyHtml: '<p>Refund received</p>' });
  });

  it('escapes the plain-text body and keeps its paragraphs', async () => {
    const { service } = serviceWith(() =>
      Promise.resolve(rendered('Hi <b>Mona</b>,\n\nRefund sent.\nThanks')),
    );

    const result = await cannedResponsePort(service).render('canned-1', {
      locale: 'en',
      ticket,
      tx,
    });

    expect(result).toEqual({
      bodyHtml: '<p>Hi &lt;b&gt;Mona&lt;/b&gt;,</p><p>Refund sent.<br>Thanks</p>',
    });
  });

  it('answers null for a canned response the brand does not have, and for an empty reply', async () => {
    const missing = serviceWith(() => Promise.reject(new NotFoundException('No such macro')));
    const empty = serviceWith(() => Promise.resolve(rendered('  ')));

    await expect(
      cannedResponsePort(missing.service).render('gone', { locale: 'en', ticket, tx }),
    ).resolves.toBeNull();
    await expect(
      cannedResponsePort(empty.service).render('blank', { locale: 'en', ticket, tx }),
    ).resolves.toBeNull();
  });

  it('lets any other failure through', async () => {
    const { service } = serviceWith(() => Promise.reject(new Error('connection lost')));

    await expect(
      cannedResponsePort(service).render('canned-1', { locale: 'en', ticket, tx }),
    ).rejects.toThrow('connection lost');
  });

  it('lists the shared canned responses for the builder', async () => {
    const { service } = serviceWith(() => Promise.resolve(rendered('')));

    await expect(cannedResponsePort(service).list(tx)).resolves.toEqual([
      { id: 'canned-1', name: 'Refund received' },
    ]);
  });
});
