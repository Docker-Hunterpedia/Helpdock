import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The Templates tab against the fixture. The preview is the interesting part:
 * it is the api's answer shown as it came back, so what is asserted is that the
 * screen asks for it and prints both halves — the filled text and the names it
 * could not fill.
 */

const renderTemplates = async () => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    initialEntries: ['/admin/ticketing/templates'],
  });

  await screen.findByRole('button', { name: 'Edit Refund request' });

  return rendered;
};

describe('the list', () => {
  it('shows each template with its department, priority and usage', async () => {
    await renderTemplates();

    const row = screen
      .getAllByRole('row')
      .find((candidate) => within(candidate).queryByText('Billing') !== null);

    if (row === undefined) {
      throw new Error('no row for the Billing template');
    }
    expect(within(row).getByText('High')).toBeInTheDocument();
    expect(within(row).getByText('24')).toBeInTheDocument();
  });

  it('says so when a template names no department', async () => {
    await renderTemplates();

    expect(screen.getAllByText('Chosen when filing').length).toBeGreaterThan(0);
  });

  it('says nothing is selected until something is', async () => {
    await renderTemplates();

    expect(screen.getByText(/Choose a template to edit/)).toBeInTheDocument();
  });
});

describe('creating', () => {
  it('adds a template and selects it', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Add template' }));
    await user.type(await screen.findByLabelText('Name'), 'Outage');
    await user.type(screen.getByLabelText('Subject'), 'Service interruption');
    await user.type(screen.getByLabelText('Body'), 'We are on it.');
    await user.click(screen.getByRole('button', { name: 'Create template' }));

    expect(await screen.findByText('Outage added')).toBeInTheDocument();
  });

  it('refuses a name the brand already has', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Add template' }));
    await user.type(await screen.findByLabelText('Name'), 'refund request');
    await user.type(screen.getByLabelText('Subject'), 'x');
    await user.type(screen.getByLabelText('Body'), 'y');
    await user.click(screen.getByRole('button', { name: 'Create template' }));

    expect(await screen.findByText('That name is already taken.')).toBeInTheDocument();
  });

  it('keeps Create disabled until a subject and a body exist', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Add template' }));
    await user.type(await screen.findByLabelText('Name'), 'Outage');

    expect(screen.getByRole('button', { name: 'Create template' })).toBeDisabled();
  });
});

describe('the editor', () => {
  it('lists the placeholders a subject may use', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Edit Refund request' }));

    // The list is built from `TEMPLATE_PLACEHOLDERS`, the same constant the
    // api's renderer reads, so the hint cannot promise a name it will not fill.
    const hints = await screen.findAllByText(/\{\{contact\.first_name\}\}/);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((node) => node.textContent?.includes('{{brand.name}}') === true)).toBe(true);
  });

  it('offers the brand’s tags as the template’s defaults', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Edit Refund request' }));

    expect(await screen.findByRole('checkbox', { name: 'Refund' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'VIP' })).not.toBeChecked();
  });

  it('saves a change to the defaults', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Edit Refund request' }));
    await user.click(await screen.findByRole('checkbox', { name: 'VIP' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Refund request saved')).toBeInTheDocument();
  });
});

describe('the preview', () => {
  it('shows the api’s rendering, with the placeholders filled', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Edit Refund request' }));
    await user.click(await screen.findByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('Refund for Mona Khalil')).toBeInTheDocument();
    expect(screen.getByText(/Hello Mona,/)).toBeInTheDocument();
  });

  it('names a placeholder the renderer does not know rather than blanking it', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Add template' }));
    await user.type(await screen.findByLabelText('Name'), 'Typo');
    // Pasted rather than typed: `user.type` reads `{{` as an escape for a
    // literal brace, and a placeholder is exactly two of them.
    await user.click(screen.getByLabelText('Subject'));
    await user.paste('Hi {{contcat.name}}');
    await user.type(screen.getByLabelText('Body'), 'Body');
    await user.click(screen.getByRole('button', { name: 'Create template' }));

    await user.click(await screen.findByRole('button', { name: 'Preview' }));

    expect(await screen.findByText(/Not a placeholder Helpdock knows/)).toBeInTheDocument();
  });

  it('closes again', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Edit Refund request' }));
    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    await user.click(await screen.findByRole('button', { name: 'Close preview' }));

    expect(screen.queryByText('Refund for Mona Khalil')).not.toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('asks first, then deletes', async () => {
    const { user } = await renderTemplates();

    await user.click(screen.getByRole('button', { name: 'Actions for Password reset' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Tickets already filed from it are untouched/)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Delete template' }));

    expect(await screen.findByText('Password reset deleted')).toBeInTheDocument();
  });
});
