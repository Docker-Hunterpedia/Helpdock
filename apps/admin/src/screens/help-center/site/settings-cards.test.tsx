import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { MOCK_HELP_CENTER } from '../../../help-center/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';
import { OpenHelpCenter } from './open-help-center.tsx';

/**
 * Help center › Settings's M5-06 cards against the fixture
 * (`Admin/HelpCenter-Settings`): Theme, Home page, Header and footer links and
 * Custom CSS, and M5-03's "View help center" and `/help-center/open`.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';

const renderSettings = async () => {
  const apis = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    helpCenterApi: apis.helpCenter,
    initialEntries: ['/help-center/settings'],
  });
  await screen.findByRole('region', { name: 'Theme' }, { timeout: 5000 });
  return { ...rendered, apis };
};

const card = (name: string) => within(screen.getByRole('region', { name }));

describe('Theme', () => {
  it('says whether the accent passes, and saves a new one', async () => {
    const { user, apis } = await renderSettings();
    const theme = card('Theme');
    expect(theme.getByText('White text on it: 5.5 : 1, passes.')).toBeInTheDocument();

    const accent = theme.getByRole('textbox', { name: 'Accent' });
    await user.clear(accent);
    await user.type(accent, '#FFFF00');
    expect(theme.getByText(/Too light/)).toBeInTheDocument();
    expect(accent).toHaveAttribute('aria-invalid', 'true');

    await user.clear(accent);
    await user.type(accent, '#2b5fb3');
    await user.click(theme.getByRole('button', { name: 'Cool' }));
    await user.click(theme.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Saved. Pages update within 60 s.');
    const site = await apis.helpCenter.site('brand');
    expect(site.appearance.theme).toMatchObject({ accent: '#2B5FB3', surfaceTone: 'cool' });
  });

  it('refuses a corner radius outside 0 to 12', async () => {
    const { user } = await renderSettings();
    const radius = card('Theme').getByRole('textbox', { name: 'Corner radius' });
    await user.clear(radius);
    await user.type(radius, '20');

    expect(card('Theme').getByText('Enter a whole number from 0 to 12.')).toBeInTheDocument();
  });

  it('uploads a logo through the image pipeline and removes it again', async () => {
    const { user } = await renderSettings();
    const theme = card('Theme');
    await user.upload(
      theme.getByLabelText('Logo: Upload', { selector: 'input' }),
      new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' }),
    );

    expect(await theme.findByText('1200 × 640')).toBeInTheDocument();
    await user.click(theme.getByRole('button', { name: 'Remove' }));
    expect(theme.getAllByText('None yet')).toHaveLength(2);
  });
});

describe('Home page', () => {
  it('reorders, removes and adds featured articles, and saves', async () => {
    const { user, apis } = await renderSettings();
    const home = card('Home page');
    const list = home.getByRole('list', { name: 'Featured articles, in order' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Refund timelines', 'Where is my order?']);

    home.getByRole('button', { name: 'Move Refund timelines' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(within(list).getAllByRole('listitem')[0]?.textContent).toBe('Where is my order?');

    await user.click(home.getByRole('button', { name: 'Remove Where is my order? from featured' }));
    await user.click(home.getByRole('checkbox', { name: /Popular articles/ }));
    await user.click(home.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Saved. Pages update within 60 s.');
    expect((await apis.helpCenter.site('brand')).home).toMatchObject({
      featuredArticleIds: [MOCK_HELP_CENTER.articles.timelines],
      popular: false,
    });
  });
});

describe('Header and footer links', () => {
  it('adds a link, refuses it until it has an address, and saves it', async () => {
    const { user, apis } = await renderSettings();
    const links = card('Header and footer links');
    await user.click(links.getAllByRole('button', { name: 'Add link' })[1] as HTMLElement);
    await user.click(links.getByRole('button', { name: 'Save changes' }));
    expect(await links.findByRole('alert')).toHaveTextContent(/Each link needs a label/);

    await user.type(links.getByRole('textbox', { name: 'New link, English label' }), 'Status');
    const address = links.getByRole('textbox', { name: 'Status, address' });
    await user.clear(address);
    await user.type(address, 'https://status.acme.test');
    await user.click(links.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('Saved. Pages update within 60 s.');
    expect((await apis.helpCenter.site('brand')).links.footer.at(-1)).toEqual({
      labelEn: 'Status',
      labelAr: '',
      url: 'https://status.acme.test',
    });
  });
});

describe('Custom CSS', () => {
  it('lists what saving removed, with the reason', async () => {
    const { user } = await renderSettings();
    const css = card('Custom CSS');
    const field = css.getByRole('textbox', { name: 'Custom CSS' });
    await user.clear(field);
    await user.click(field);
    await user.paste(
      '@import url("https://x.test/a.css");\n.bar { position: fixed; }\n.a { color: red; }',
    );
    await user.click(css.getByRole('button', { name: 'Save changes' }));

    const status = await css.findByRole('status');
    expect(status).toHaveTextContent('Sanitised on save: these rules were removed');
    expect(status).toHaveTextContent('@import is not allowed. Pick a typeface under Theme.');
    expect(status).toHaveTextContent('Fixed overlays are not allowed.');
    await user.click(css.getByRole('button', { name: 'Dismiss' }));
    expect(css.queryByRole('status')).toBeNull();
  });
});

describe('opening the help center', () => {
  it('links "View help center" to the open step in a new tab', async () => {
    await renderSettings();
    const link = screen.getByRole('link', { name: 'View help center' });

    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('href')).toMatch(/^\/help-center\/open\?brand=/);
  });

  it('asks for a staff pass and leaves for the help center', async () => {
    const apis = await signedInMockApis();
    const navigate = vi.fn();
    renderApp(
      <Routes>
        <Route path="/help-center/open" element={<OpenHelpCenter navigate={navigate} />} />
      </Routes>,
      {
        authApi: apis.auth,
        staffApi: apis.staff,
        helpCenterApi: apis.helpCenter,
        initialEntries: [`/help-center/open?brand=${BRAND}&path=%2Far`],
      },
    );

    expect(screen.getByRole('status')).toHaveTextContent('Opening the help center…');
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(expect.stringContaining('/_hd/staff?pass='));
    });
  });

  it('says so when the address cannot be opened', async () => {
    const apis = await signedInMockApis();
    renderApp(
      <Routes>
        <Route path="/help-center/open" element={<OpenHelpCenter navigate={vi.fn()} />} />
      </Routes>,
      {
        authApi: apis.auth,
        staffApi: apis.staff,
        helpCenterApi: apis.helpCenter,
        initialEntries: ['/help-center/open?brand=nope'],
      },
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The help center could not be opened.',
    );
  });
});
