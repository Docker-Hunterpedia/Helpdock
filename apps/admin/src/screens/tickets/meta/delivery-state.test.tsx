import type { Attachment, MetaDeliveryView, MetaPlatform } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { renderApp } from '../../../test/render.tsx';
import { DeliveryNotice, DeliveryTrail } from './delivery-state.tsx';

/**
 * The states of a reply on a Meta ticket (DESIGN §6.3 DeliveryState,
 * `Admin/Ticket-Meta` panels 2, 3 and 6): the trail at the end of the author
 * line, and the strips under the bubble.
 */

const STAMP = new Date(2026, 9, 11, 9, 44).toISOString();

const delivery = (overrides: Partial<MetaDeliveryView> = {}): MetaDeliveryView => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000a0001',
  ticketMessageId: '0192c3f0-1a2b-7c3d-8e4f-000000090001',
  status: 'sent',
  partsSent: 1,
  partsTotal: 1,
  leftOut: [],
  attempts: 0,
  lastError: null,
  errorCode: null,
  tag: null,
  templateName: null,
  sentAt: STAMP,
  deliveredAt: null,
  readAt: null,
  failedAt: null,
  ...overrides,
});

const file = (id: string, kind: Attachment['kind'], name: string): Attachment => ({
  id,
  ticketId: '0192c3f0-1a2b-7c3d-8e4f-000000001036',
  messageId: '0192c3f0-1a2b-7c3d-8e4f-000000090001',
  uploaderType: 'staff',
  status: 'ready',
  rejectReason: null,
  scanStatus: 'clean',
  variants: {},
  createdAt: STAMP,
  processedAt: STAMP,
  originalName: name,
  mime: kind === 'file' ? 'application/msword' : 'image/webp',
  kind,
  size: 1024,
});

const renderTrail = (value: MetaDeliveryView) =>
  renderApp(
    <p data-testid="line">
      Lina Haddad · to WhatsApp · 09:41
      <DeliveryTrail delivery={value} />
    </p>,
  );

const line = (): HTMLElement => screen.getByTestId('line');

const renderNotice = (
  value: MetaDeliveryView,
  options: {
    platform?: MetaPlatform;
    attachments?: readonly Attachment[];
    busy?: boolean;
    onRetry?: () => void;
  } = {},
) =>
  renderApp(
    <DeliveryNotice
      delivery={value}
      platform={options.platform ?? 'whatsapp'}
      attachments={options.attachments ?? []}
      busy={options.busy ?? false}
      onRetry={options.onRetry ?? (() => {})}
    />,
  );

afterEach(() => {
  localStorage.clear();
});

describe('DeliveryTrail', () => {
  it('says Sending with a clock, and the part when the reply is several messages', () => {
    renderTrail(delivery({ status: 'queued', partsSent: 0 }));
    expect(line()).toHaveTextContent('to WhatsApp · 09:41 · Sending');
    expect(line()).not.toHaveTextContent('part');
    expect(line().querySelector('svg.lucide-clock')).not.toBeNull();
  });

  it('counts the part being sent, never past the last', () => {
    renderTrail(delivery({ status: 'queued', partsSent: 1, partsTotal: 3 }));
    expect(line()).toHaveTextContent('Sending · part 2 of 3 · 3 messages');
  });

  it('keeps the last part in view when every part is accepted but the report has not come', () => {
    renderTrail(delivery({ status: 'queued', partsSent: 3, partsTotal: 3 }));
    expect(line()).toHaveTextContent('Sending · part 3 of 3');
  });

  it('says Sent with one check, and that a reply was several messages', () => {
    renderTrail(delivery({ status: 'sent', partsSent: 2, partsTotal: 2 }));

    expect(line()).toHaveTextContent('to WhatsApp · 09:41 · Sent · 2 messages');
    expect(line().querySelectorAll('svg.lucide-check')).toHaveLength(1);
    expect(line().querySelector('svg.lucide-check-check')).toBeNull();
  });

  it('says Delivered with one check and the time the platform reported', () => {
    renderTrail(delivery({ status: 'delivered', deliveredAt: STAMP }));

    expect(line()).toHaveTextContent('Delivered09:44');
    expect(line().querySelectorAll('svg.lucide-check')).toHaveLength(1);
    expect(line().querySelector('svg.lucide-check-check')).toBeNull();
    expect(within(line()).getByText('09:44').closest('bdi')).not.toBeNull();
  });

  it('says Read with two checks, as the widget’s Seen does, and the time', () => {
    renderTrail(delivery({ status: 'read', deliveredAt: STAMP, readAt: STAMP }));

    expect(line()).toHaveTextContent('Read09:44');
    expect(line().querySelector('svg.lucide-check-check')).not.toBeNull();
  });

  it('leaves out the time a report did not carry', () => {
    renderTrail(delivery({ status: 'read', readAt: null }));

    expect(line()).toHaveTextContent('to WhatsApp · 09:41 · Read');
    expect(line()).not.toHaveTextContent('09:44');
  });

  it.each(['failed', 'refused'] as const)('adds nothing to the line of a %s reply', (status) => {
    renderTrail(delivery({ status, lastError: 'x' }));

    expect(line()).toHaveTextContent(/^Lina Haddad · to WhatsApp · 09:41$/);
  });

  it('is in Arabic, with the time in Latin digits', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    renderTrail(delivery({ status: 'read', deliveredAt: STAMP, readAt: STAMP }));

    expect(line()).toHaveTextContent('قُرئ');
    expect(line().textContent).toContain('09:44');
  });
});

describe('DeliveryNotice, refused', () => {
  const refused = delivery({
    status: 'refused',
    partsSent: 0,
    sentAt: null,
    attempts: 0,
    lastError:
      'Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
    errorCode: '131047',
    failedAt: STAMP,
  });

  it('says Not sent because the window had closed, in the platform’s words and with its code', () => {
    renderNotice(refused);

    const strip = screen.getByText('Not sent').parentElement;
    expect(strip).toHaveTextContent(
      'Not sent · the reply window had closed · WhatsApp: “Message failed to send because more than 24 hours have passed since the customer last replied to this number.” (131047)',
    );
    expect(strip?.parentElement?.querySelector('svg.lucide-ban')).not.toBeNull();
  });

  it('offers no Retry and says what to do instead', () => {
    renderNotice(refused);

    expect(screen.queryByRole('button')).toBeNull();
    expect(
      screen.getByText('No Retry: write a new reply once the customer writes again.'),
    ).toBeVisible();
  });

  it('is not a live region of its own: the thread is the log that reads it', () => {
    renderNotice(refused);

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is in Arabic', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    renderNotice(refused);

    expect(screen.getByText('لم يُرسل')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('DeliveryNotice, failed', () => {
  const failed = delivery({
    status: 'failed',
    partsSent: 1,
    partsTotal: 2,
    attempts: 5,
    lastError: '(#1200) Temporary send message failure. Please try again later.',
    errorCode: '1200',
    failedAt: STAMP,
  });

  it('says Not delivered with the part, Meta’s words, its code and the attempts', () => {
    renderNotice(failed, { platform: 'messenger' });

    const strip = screen.getByText('Not delivered').parentElement;
    expect(strip).toHaveTextContent(
      'Not delivered · part 2 of 2 · Messenger: “(#1200) Temporary send message failure. Please try again later.” (1200) · 5 attempts',
    );
    expect(strip?.parentElement?.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
  });

  it('says what reached the customer, and that Retry sends the rest', () => {
    renderNotice(failed, { platform: 'messenger' });

    expect(
      screen.getByText('The first part reached the customer; Retry sends the rest.'),
    ).toBeVisible();
  });

  it('counts the earlier parts when there are several', () => {
    renderNotice(delivery({ ...failed, partsSent: 2, partsTotal: 4 }));

    expect(
      screen.getByText('The first 2 parts reached the customer; Retry sends the rest.'),
    ).toBeVisible();
    expect(screen.getByText('Not delivered').parentElement).toHaveTextContent('part 3 of 4');
  });

  it('says nothing about earlier parts when none went, nor a part when there is one message', () => {
    renderNotice(delivery({ ...failed, partsSent: 0, partsTotal: 1, attempts: 1 }));

    expect(screen.queryByText(/reached the customer/)).toBeNull();
    expect(screen.getByText('Not delivered').parentElement).not.toHaveTextContent('part');
    expect(screen.getByText('Not delivered').parentElement).toHaveTextContent('1 attempt');
  });

  it('offers Retry, named for the platform, and asks for it once', async () => {
    const onRetry = vi.fn();
    const { user } = renderNotice(failed, { platform: 'messenger', onRetry });

    await user.click(screen.getByRole('button', { name: 'Retry sending this reply to Messenger' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('holds Retry while a retry is on its way', () => {
    renderNotice(failed, { platform: 'messenger', busy: true });

    expect(screen.getByRole('button', { name: /Retry sending/ })).toBeDisabled();
  });

  it('is in Arabic, with Retry named for the platform', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    renderNotice(failed, { platform: 'messenger' });

    expect(screen.getByText('لم يُسلَّم')).toBeVisible();
    expect(screen.getByRole('button', { name: /إعادة إرسال هذا الرد إلى/ })).toBeVisible();
  });
});

describe('DeliveryNotice, a file left out', () => {
  const word = file('0192c3f0-1a2b-7c3d-8e4f-0000000b000a', 'file', 'warranty-terms.docx');
  const photo = file('0192c3f0-1a2b-7c3d-8e4f-0000000b000b', 'image', 'lid.webp');

  it('names the document and says Instagram sends PDF files only, and that the customer was told', () => {
    renderNotice(
      delivery({
        leftOut: [{ attachmentId: word.id, name: word.originalName, reason: 'unsupported-type' }],
      }),
      { platform: 'instagram', attachments: [word] },
    );

    const note = screen.getByText(/left out/);
    expect(note).toHaveTextContent(
      'warranty-terms.docx left out: Instagram sends PDF files only. The customer was told.',
    );
    expect(note.closest('p')?.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
    expect(within(note).getByText('warranty-terms.docx').tagName).toBe('BDI');
  });

  it('does not say PDF only of an image Instagram would not take', () => {
    renderNotice(
      delivery({
        leftOut: [{ attachmentId: photo.id, name: photo.originalName, reason: 'unsupported-type' }],
      }),
      { platform: 'instagram', attachments: [photo] },
    );

    expect(screen.getByText(/left out/)).toHaveTextContent(
      'lid.webp left out: Instagram does not take this kind of file. The customer was told.',
    );
  });

  it('says a file was over the platform’s size', () => {
    renderNotice(
      delivery({
        leftOut: [{ attachmentId: photo.id, name: photo.originalName, reason: 'too-large' }],
      }),
      { platform: 'whatsapp', attachments: [photo] },
    );

    expect(screen.getByText(/left out/)).toHaveTextContent(
      'lid.webp left out: It is larger than WhatsApp allows. The customer was told.',
    );
  });

  it('is a line under the reply and no strip when nothing else went wrong', () => {
    renderNotice(
      delivery({
        status: 'read',
        leftOut: [{ attachmentId: word.id, name: word.originalName, reason: 'unsupported-type' }],
      }),
      { platform: 'instagram', attachments: [word] },
    );

    expect(screen.queryByText('Not delivered')).toBeNull();
    expect(screen.queryByText('Not sent')).toBeNull();
    expect(screen.getAllByText(/left out/)).toHaveLength(1);
  });
});
