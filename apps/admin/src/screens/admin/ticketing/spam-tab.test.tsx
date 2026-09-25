import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The Spam tab against the fixture: what the screen decides — which refusal
 * stays in the card, what the confirmation says, what the search keeps — rather
 * than the markup it decides with.
 */

const renderSpam = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketingApi: apis.ticketing,
    ticketsApi: apis.tickets,
    initialEntries: ['/admin/ticketing/spam'],
  });

  await screen.findByText('promo-deals.biz');

  return rendered;
};

const rowFor = (value: string): HTMLElement => {
  const row = screen
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(value) !== null);
  if (row === undefined) {
    throw new Error(`no row for ${value}`);
  }

  return row;
};

describe('the block list', () => {
  it('draws the artboard’s rows with what each has dropped', async () => {
    await renderSpam();

    expect(within(rowFor('promo-deals.biz')).getByText('112')).toBeVisible();
    expect(within(rowFor('promo-deals.biz')).getByText('Domain')).toBeVisible();
    expect(within(rowFor('spam@promo-deals.biz')).getByText('Address')).toBeVisible();
  });

  it('narrows the list to what the search matches, and says when nothing does', async () => {
    const { user } = await renderSpam();

    await user.type(screen.getByLabelText('Search the block list'), '555 0100');
    expect(screen.getAllByRole('row')).toHaveLength(2);

    await user.clear(screen.getByLabelText('Search the block list'));
    await user.type(screen.getByLabelText('Search the block list'), 'nothing-like-it');
    expect(screen.getByText('No sender matches')).toBeVisible();
  });
});

describe('blocking a sender', () => {
  it('adds the normalised value to the list', async () => {
    const { user } = await renderSpam();

    await user.click(screen.getByRole('button', { name: 'Block a sender' }));
    await user.type(await screen.findByLabelText('Sender'), 'Bot@Crypto.BIZ');
    await user.click(screen.getByRole('button', { name: 'Block' }));

    expect(await screen.findByText('bot@crypto.biz')).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Block a sender' })).not.toBeInTheDocument();
  });

  it('keeps the refusal of the brand’s own domain in the card, beside the field', async () => {
    const { user } = await renderSpam();

    await user.click(screen.getByRole('button', { name: 'Block a sender' }));
    await user.click(await screen.findByRole('combobox', { name: 'Kind' }));
    await user.click(await screen.findByRole('option', { name: 'Email domain' }));
    await user.type(screen.getByLabelText('Sender'), 'helpdock.com');
    await user.click(screen.getByRole('button', { name: 'Block' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A domain your brand sends from cannot be blocked.',
    );
    expect(screen.getByLabelText('Sender')).toHaveAttribute('aria-invalid', 'true');
  });

  it('refuses a sender that is already blocked', async () => {
    const { user } = await renderSpam();

    await user.click(screen.getByRole('button', { name: 'Block a sender' }));
    await user.type(await screen.findByLabelText('Sender'), 'spam@promo-deals.biz');
    await user.click(screen.getByRole('button', { name: 'Block' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already on the block list');
  });
});

describe('unblocking', () => {
  it('asks first, then removes the row', async () => {
    const { user } = await renderSpam();

    await user.click(screen.getByRole('button', { name: 'Unblock promo-deals.biz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unblock promo-deals.biz?' });
    await user.click(within(dialog).getByRole('button', { name: 'Unblock' }));

    expect(await screen.findByText('Unblocked promo-deals.biz')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unblock promo-deals.biz' })).toBeNull();
  });
});

describe('the Spam status card', () => {
  it('turns "Offer Block sender" off, and the brand setting with it', async () => {
    const { user, ticketingApi } = await renderSpam();
    const offer = screen.getByRole('checkbox', {
      name: /Offer "Block sender" when marking as spam/,
    });

    expect(offer).toBeChecked();
    await user.click(offer);

    expect(await screen.findByText('Spam settings saved')).toBeInTheDocument();
    expect((await ticketingApi.brand('brand')).settings.offerBlockSender).toBe(false);
  });
});
