import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MockAttachmentUploader } from '../../media/mock-uploader.js';
import { MockTelegramApi } from '../../telegram/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import {
  MOCK_TELEGRAM_VOICE,
  MOCK_TICKET_ARABIC,
  MOCK_TICKET_REFUND,
  type MockTicketsApi,
} from '../../tickets/mock-api.js';
import { splitLocation } from './telegram/location-line.tsx';
import { voiceDuration, waveform } from './telegram/voice-note.tsx';

/**
 * The ticket view's Telegram half (artboard `Admin/Ticket-Telegram`, M6-02,
 * M6-03): the channel chip with the username, "via @bot" and "Sent", the voice
 * note and the location, "Not delivered · Retry", the composer's caption and
 * the ChannelIdentityCard.
 */

const wideViewport = (): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
};

const open = async (ticketId: string, telegramApi = new MockTelegramApi()) => {
  const apis = await signedInMockApis();
  const uploader = new MockAttachmentUploader();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    contactsApi: apis.contacts,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets as MockTicketsApi,
    telegramApi,
    uploader,
    initialEntries: [`/tickets/${ticketId}?view=all`],
  });
  await screen.findByRole('region', { name: 'Ticket list' });
  return { ...rendered, telegramApi, uploader };
};

const thread = (): HTMLElement => screen.getByRole('list', { name: 'Conversation' });

describe('a Telegram ticket', () => {
  beforeEach(wideViewport);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the chat in the header and the bot under each message', async () => {
    await open(MOCK_TICKET_ARABIC);

    expect(await screen.findByText(/Telegram · @sara_h/)).toBeVisible();
    expect(within(thread()).getAllByText('via @helpdock_support_bot').length).toBeGreaterThan(0);
    expect(within(thread()).getAllByText('to the Telegram chat')).toHaveLength(2);
    expect(within(thread()).getByText('Sent')).toBeVisible();
  });

  it('draws a voice note as a player and a location as a line with a map link', async () => {
    const { user, uploader } = await open(MOCK_TICKET_ARABIC);
    const play = await screen.findByRole('button', { name: 'Play voice note, 0:14' });
    const downloadUrl = vi.spyOn(uploader, 'downloadUrl');
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    await user.click(play);
    await waitFor(() => {
      expect(downloadUrl).toHaveBeenCalledWith(
        expect.any(String),
        MOCK_TICKET_ARABIC,
        MOCK_TELEGRAM_VOICE,
        'opus',
      );
    });

    const map = within(thread()).getByRole('link', {
      name: 'Open the location 24.7136, 46.6753 on OpenStreetMap',
    });
    expect(map).toHaveAttribute('href', expect.stringContaining('mlat=24.7136'));
    expect(within(thread()).queryByText(/^https:\/\/www\.openstreetmap\.org\//)).toBeNull();
  });

  it('says which reply Telegram refused, and retries it', async () => {
    const { user, telegramApi } = await open(MOCK_TICKET_ARABIC);
    const retry = vi.spyOn(telegramApi, 'retryDelivery');

    const failure = await within(thread()).findByText('Not delivered');
    expect(failure.closest('[role="status"]')).toHaveTextContent(
      '403: Forbidden: bot was blocked by the user · 5 tries',
    );
    await user.click(screen.getByRole('button', { name: 'Retry sending this reply to Telegram' }));

    await waitFor(() => {
      expect(retry).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(within(thread()).queryByText('Not delivered')).toBeNull();
    });
  });

  it('says where a reply goes and who sends it', async () => {
    await open(MOCK_TICKET_ARABIC);
    const form = screen.getByRole('form', { name: 'Reply or internal note' });

    expect(await within(form).findByText('To the Telegram chat')).toBeVisible();
    expect(
      within(form).getByText('Sent by @helpdock_support_bot as plain text; no signature.'),
    ).toBeVisible();
  });

  it('shows the Telegram identity under the contact, and copies the chat id', async () => {
    const { user } = await open(MOCK_TICKET_ARABIC);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const card = await screen.findByRole('region', { name: 'Telegram identity' });
    expect(within(card).getByText('884413201')).toBeVisible();
    expect(within(card).getByText('@sara_h')).toBeVisible();
    expect(within(card).getByText('Arabic, chosen at /start')).toBeVisible();
    expect(within(card).getByText('@helpdock_support_bot')).toBeVisible();

    await user.click(within(card).getByRole('button', { name: 'Copy chat id' }));
    expect(writeText).toHaveBeenCalledWith('884413201');
  });

  it('draws nothing Telegram on a ticket of another channel', async () => {
    await open(MOCK_TICKET_REFUND);
    await screen.findByRole('form', { name: 'Reply or internal note' });

    expect(screen.queryByRole('region', { name: 'Telegram identity' })).toBeNull();
    expect(screen.queryByText('To the Telegram chat')).toBeNull();
  });
});

describe('the Telegram thread helpers', () => {
  it('lifts the location paragraph out of a body and keeps the rest', () => {
    const split = splitLocation(
      '<p>At the office</p><p>Location: 52.52, 13.405<br><a href="https://www.openstreetmap.org/?mlat=52.52&amp;mlon=13.405#map=17/52.52/13.405">link</a></p>',
    );

    expect(split?.html).toBe('<p>At the office</p>');
    expect(split?.location).toEqual({
      latitude: '52.52',
      longitude: '13.405',
      url: 'https://www.openstreetmap.org/?mlat=52.52&mlon=13.405#map=17/52.52/13.405',
    });
  });

  it('leaves a body with no map link, or with any other link, alone', () => {
    expect(splitLocation('<p>Hello</p>')).toBeUndefined();
    expect(
      splitLocation('<p><a href="https://www.openstreetmap.org/about">openstreetmap.org</a></p>'),
    ).toBeUndefined();
  });

  it('is not fooled by a marker link on a host that only contains the map host', () => {
    expect(
      splitLocation(
        '<p><a href="https://www.openstreetmap.org.evil.example/?mlat=1&amp;mlon=2">x</a></p>',
      ),
    ).toBeUndefined();
    expect(
      splitLocation(
        '<p><a href="https://evil.example/?u=www.openstreetmap.org&amp;mlat=1&amp;mlon=2">x</a></p>',
      ),
    ).toBeUndefined();
  });

  it('writes a voice note’s length and draws the same waveform for the same file', () => {
    expect(voiceDuration(14_000)).toBe('0:14');
    expect(voiceDuration(65_400)).toBe('1:05');
    expect(waveform('abc')).toEqual(waveform('abc'));
    expect(waveform('abc').every((height) => height >= 6 && height <= 18)).toBe(true);
  });
});
