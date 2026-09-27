import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/routes.tsx';
import { MockEmailApi } from '../../email/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { tooManyLines } from './signature-page.tsx';

/** Your account › Email signature (artboard `AdminSignature`, M2-05). */

const renderSignature = async (emailApi = new MockEmailApi()) => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    emailApi,
    initialEntries: ['/me/signature'],
  });
  await screen.findByRole('heading', { name: 'Email signature' });
  return { ...rendered, emailApi };
};

describe('the Email signature tab', () => {
  it('sits beside Security and shows the stored signature in both languages', async () => {
    await renderSignature();

    expect(screen.getByRole('tab', { name: 'Email signature' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Security' })).toHaveAttribute('href', '/me/security');
    expect(await screen.findByLabelText('English')).toHaveValue(
      'Lina Haddad\nBilling team · Helpdock',
    );
    expect(screen.getByLabelText(/Arabic/)).toHaveAttribute('dir', 'rtl');
  });

  it('previews the end of a reply as it is typed, in each language', async () => {
    const { user } = await renderSignature();
    const preview = screen.getByRole('complementary', { name: 'Preview' });
    const english = await screen.findByLabelText('English');

    await user.clear(english);
    await user.type(english, 'Omar{Enter}Refunds');

    expect(within(preview).getAllByText('Omar').length).toBeGreaterThan(0);
    expect(within(preview).getByText('Hi Mona,')).toBeVisible();
    expect(within(preview).getByText('مرحباً سارة،')).toBeVisible();
  });

  it('refuses a seventh line and saves six', async () => {
    const { user, emailApi } = await renderSignature();
    const english = await screen.findByLabelText('English');

    await user.clear(english);
    await user.type(english, '1{Enter}2{Enter}3{Enter}4{Enter}5{Enter}6{Enter}7');
    await user.click(screen.getByRole('button', { name: 'Save signature' }));
    expect(screen.getByText('A signature can have at most 6 lines.')).toBeVisible();
    expect(english).toHaveAttribute('aria-invalid', 'true');

    await user.type(english, '{Backspace}{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Save signature' }));

    expect(await screen.findByText('Signature saved.')).toBeVisible();
    expect((await emailApi.signature()).en).toBe('1\n2\n3\n4\n5\n6');
  });

  it('puts the stored signature back on Discard', async () => {
    const { user } = await renderSignature();
    const english = await screen.findByLabelText('English');

    await user.type(english, ' extra');
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(english).toHaveValue('Lina Haddad\nBilling team · Helpdock');
  });
});

describe('tooManyLines', () => {
  it('ignores trailing blank lines', () => {
    expect(tooManyLines('1\n2\n3\n4\n5\n6\n\n')).toBe(false);
    expect(tooManyLines('1\n2\n3\n4\n5\n6\n7')).toBe(true);
  });
});
