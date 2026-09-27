import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../../app/routes.tsx';
import { MockChannelsApi } from '../../../../channels/mock-api.js';
import { renderApp } from '../../../../test/render.tsx';
import { signedInMockApis } from '../../../../test/signed-in.js';
import { embedSnippet } from './widget-tab.tsx';

/**
 * Channels › Widget against the fixture (artboard `AdminWidget`; M4-03, M4-06
 * to M4-08): the cards an Admin and a Team Leader see, each card's save, and
 * the refusals the api would give, caught before the request.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

const renderWidget = async (role: 'admin' | 'teamLeader' = 'admin') => {
  const apis = await signedInMockApis();
  const channelsApi = new MockChannelsApi();
  if (role !== 'admin') {
    const session = await apis.auth.me();
    vi.spyOn(apis.auth, 'me').mockResolvedValue(
      session === null ? null : { ...session, user: { ...session.user, role } },
    );
  }
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    channelsApi,
    initialEntries: ['/admin/channels/widget'],
  });
  await screen.findByRole('heading', { name: 'Appearance' }, { timeout: 10_000 });
  return { ...rendered, channelsApi };
};

const card = (name: string): HTMLElement => screen.getByRole('region', { name });

describe('Channels › Widget', () => {
  it('shows an Admin every card, and the snippet for this brand', async () => {
    await renderWidget();

    expect(screen.getByRole('tab', { name: 'Widget' })).toHaveAttribute('aria-selected', 'true');
    for (const heading of [
      'Embed code',
      'Conversation',
      'What visitors can send',
      'Where the widget may run',
      'Signed identity',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    }
    expect(within(card('Embed code')).getByText(/<helpdock-widget brand=/)).toBeVisible();
  });

  it('shows a Team Leader the widget alone, without the Admin cards or the email tabs', async () => {
    await renderWidget('teamLeader');

    expect(screen.getByRole('tab', { name: 'Widget' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Mailboxes' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Outgoing email' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Where the widget may run' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Signed identity' })).toBeNull();
  });

  it('previews the draft and refuses an accent white text cannot be read on', async () => {
    const { user, channelsApi } = await renderWidget();
    const appearance = card('Appearance');
    const accent = within(appearance).getByLabelText('Accent');

    await user.clear(accent);
    await user.paste('#FDE68A');
    expect(
      within(appearance).getByText(/Below 3 : 1 is refused; choose a darker colour/),
    ).toBeVisible();
    await user.click(within(appearance).getByRole('button', { name: 'Save changes' }));
    expect((await channelsApi.widgetSettings()).appearance.accent).toBe('#0F766E');

    await user.clear(accent);
    await user.paste('#1D4ED8');
    await user.click(within(appearance).getByRole('radio', { name: /Contact form/ }));
    await user.click(within(appearance).getByRole('button', { name: 'Icon and text' }));
    expect(within(screen.getByRole('complementary', { name: 'Live preview' })).getAllByText('Chat with us').length).toBeGreaterThan(0);
    await user.click(within(appearance).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Appearance saved')).toBeVisible();
    expect((await channelsApi.widgetSettings()).appearance).toMatchObject({
      accent: '#1D4ED8',
      mode: 'form',
      launcher: 'icon_text',
    });
  });

  it('previews in Arabic whatever the admin is in', async () => {
    const { user } = await renderWidget();
    const preview = screen.getByRole('complementary', { name: 'Live preview' });

    await user.click(within(preview).getByRole('button', { name: 'العربية' }));

    expect(within(preview).getByText('ابدأ الدردشة')).toBeVisible();
  });

  it('adds a custom pre-chat field, reorders with the handle and saves', async () => {
    const { user, channelsApi } = await renderWidget();
    const conversation = card('Conversation');
    const handle = within(conversation).getByRole('button', { name: 'Reorder Email' });

    handle.focus();
    await user.keyboard('{ArrowUp}');
    await user.click(
      within(conversation).getByRole('checkbox', { name: 'Offer a transcript by email' }),
    );
    await user.click(within(conversation).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Conversation settings saved')).toBeVisible();
    const saved = (await channelsApi.widgetSettings()).conversation;
    expect(saved.prechatFields[0]).toMatchObject({ kind: 'email' });
    expect(saved.transcriptEnabled).toBe(false);
  });

  it('refuses a size above the install limit and saves the policy once corrected', async () => {
    const { user, channelsApi } = await renderWidget();
    const policy = card('What visitors can send');
    const size = within(policy).getByLabelText('Video maximum size in MB');

    await user.clear(size);
    await user.type(size, '500');
    await user.click(within(policy).getByRole('button', { name: 'Save changes' }));
    expect(within(policy).getByRole('alert')).toHaveTextContent(
      "Above this install's upload limit",
    );

    await user.clear(size);
    await user.type(size, '40');
    await user.click(within(policy).getByRole('checkbox', { name: 'Emoji' }));
    await user.click(within(policy).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Content policy saved')).toBeVisible();
    const saved = (await channelsApi.widgetSettings()).contentPolicy;
    expect(saved.video.maxBytes).toBe(40 * 1_048_576);
    expect(saved.emoji).toBe(false);
  });

  it('adds an origin, refuses one with a path, and asks for keys before the bot check', async () => {
    const { user, channelsApi } = await renderWidget();
    const access = card('Where the widget may run');
    const add = within(access).getByLabelText('Add an origin');

    await user.type(add, 'https://shop.helpdock.com/checkout');
    await user.click(within(access).getByRole('button', { name: 'Add origin' }));
    expect(within(access).getByText(/Enter an origin only/)).toBeVisible();

    await user.clear(add);
    await user.type(add, 'https://App.Helpdock.com{Enter}');
    expect(within(access).getByText('https://app.helpdock.com')).toBeVisible();

    await user.click(within(access).getByRole('checkbox', { name: /Check for bots/ }));
    await user.click(within(access).getByRole('button', { name: 'Save changes' }));
    expect(within(access).getByText(/Enter a site key and a secret key/)).toBeVisible();

    await user.type(within(access).getByLabelText('Site key'), '0x4AAA');
    await user.type(within(access).getByLabelText('Secret key'), 'the-secret');
    await user.click(within(access).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Access settings saved')).toBeVisible();
    const saved = (await channelsApi.widgetSettings()).access;
    expect(saved?.allowedOrigins).toContain('https://app.helpdock.com');
    expect(saved?.captchaEnabled).toBe(true);
    expect(saved?.captchaSecret).not.toBeNull();
  });

  it('shows a new signing secret once, and forgets it when told', async () => {
    const { user } = await renderWidget();
    const signed = card('Signed identity');

    await user.click(within(signed).getByRole('button', { name: 'Replace' }));

    const fresh = await within(signed).findByLabelText('New signing secret');
    expect(fresh).toHaveValue('whsec_bW9jay1zaWduaW5nLXNlY3JldC1zaG93bi1vbmNlLXBsZWFzZQ');
    expect(within(signed).getByRole('status')).toHaveTextContent('It will not be shown again.');

    await user.click(within(signed).getByRole('button', { name: 'I have copied it' }));
    expect(within(signed).queryByLabelText('New signing secret')).toBeNull();
  });
});

describe('embedSnippet', () => {
  it('loads the widget from this install for this brand', () => {
    expect(embedSnippet('https://support.example.com', BRAND)).toBe(
      `<script src="https://support.example.com/widget.js" async></script>\n<helpdock-widget brand="${BRAND}"></helpdock-widget>`,
    );
  });
});
