import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { MockAutomationApi } from '../../../automation/mock-api.js';
import { MOCK_ROUTING } from '../../../automation/mock-routing.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * The Routing tab (`Admin/Automation-Routing`) against the fixture: the four
 * steps as an Admin reads them, and Test routing through each of its answers.
 */

const LOAD = { timeout: 5_000 };

const renderRouting = async (automation = new MockAutomationApi()) => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    automationApi: automation,
    initialEntries: ['/admin/automation/routing'],
  });
  return { ...rendered, automation };
};

const stepOf = (title: string): HTMLElement => {
  const heading = screen.getByRole('heading', { name: new RegExp(title) });
  const step = heading.closest('li');
  if (step === null) {
    throw new Error(`no step named ${title}`);
  }
  return step;
};

describe('the explainer', () => {
  it('lists the four steps with what each holds today', async () => {
    await renderRouting();

    await screen.findByRole('heading', { name: 'How tickets are routed' }, LOAD);
    expect(screen.getByRole('tab', { name: 'Routing', selected: true })).toBeInTheDocument();

    const arrival = within(stepOf('Arrival'));
    expect(arrival.getByText('billing@helpdock.com')).toBeInTheDocument();
    expect(arrival.getByText('Billing')).toBeInTheDocument();
    // The chat widget and the web form, which has no department of its own.
    expect(arrival.getAllByText('Support (the brand’s first department)')).toHaveLength(2);
    expect(arrival.getByText('API requests')).toBeInTheDocument();

    const rules = within(stepOf('Rules on'));
    expect(rules.getByText('Run in order. 2 enabled.')).toBeInTheDocument();
    expect(rules.getByText('Web form to Sales')).toBeInTheDocument();
    expect(rules.getByText('Off')).toBeInTheDocument();

    expect(
      within(stepOf('AI triage')).getByText('Queued by “Telegram to Sales”'),
    ).toBeInTheDocument();

    const assignment = within(stepOf('Assignment'));
    expect(assignment.getByText('Round-robin · 4 people')).toBeInTheDocument();
    expect(assignment.getByText('Skill-based · 3 people · cap 8')).toBeInTheDocument();
  });

  it('links each step to where it is edited', async () => {
    await renderRouting();
    await screen.findByRole('heading', { name: 'How tickets are routed' }, LOAD);

    expect(screen.getByRole('link', { name: 'Edit Assignment' })).toHaveAttribute(
      'href',
      '/admin/ticketing/assignment',
    );
    expect(screen.getByRole('link', { name: /^Edit Rules on/ })).toHaveAttribute(
      'href',
      '/admin/automation/rules',
    );
  });

  it('says it could not read the pipeline, and reads it again on request', async () => {
    const automation = new MockAutomationApi();
    const read = vi.spyOn(automation, 'routing').mockRejectedValueOnce(new Error('offline'));
    const { user } = await renderRouting(automation);

    expect(
      await screen.findByText('How tickets are routed could not be read.', {}, LOAD),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('heading', { name: 'How tickets are routed' }),
    ).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('Test routing', () => {
  it('asks for a subject only where the door takes one', async () => {
    const { user } = await renderRouting();
    await screen.findByRole('heading', { name: 'Test routing' }, LOAD);
    const entry = screen.getByLabelText('Channel and entry point');

    expect(screen.getByLabelText('Subject')).toBeInTheDocument();
    for (const door of [`telegram_bot:${MOCK_ROUTING.bot}`, 'widget:']) {
      await user.selectOptions(entry, door);
      expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument();
    }
    await user.selectOptions(entry, 'web_form:');
    expect(screen.getByLabelText('Subject')).toBeInTheDocument();
  });

  const run = async (
    fill: (user: Awaited<ReturnType<typeof renderRouting>>['user']) => Promise<void>,
    automation = new MockAutomationApi(),
  ) => {
    const rendered = await renderRouting(automation);
    await screen.findByRole('heading', { name: 'Test routing' }, LOAD);
    await fill(rendered.user);
    await rendered.user.click(screen.getByRole('button', { name: 'Run test' }));
    return rendered;
  };

  it('promises nothing is written, in the panel itself', async () => {
    await renderRouting();

    expect(
      await screen.findByText(/Nothing is created, sent or logged/, {}, LOAD),
    ).toBeInTheDocument();
  });

  it('walks a Telegram sample: the rule that matches, triage queued, the SLA, the assignment', async () => {
    await run(async (user) => {
      await user.selectOptions(
        screen.getByLabelText('Channel and entry point'),
        `telegram_bot:${MOCK_ROUTING.bot}`,
      );
      await user.type(screen.getByLabelText('From'), '700100200');
      await user.type(screen.getByLabelText('Message'), 'Hello');
    });

    const result = await screen.findByRole('heading', { name: 'Result' });
    const steps = within(result.parentElement as HTMLElement);
    expect(await steps.findByText('Rule “Telegram to Sales” matches')).toBeInTheDocument();
    expect(steps.getByText('AI triage would be queued')).toBeInTheDocument();
    expect(steps.getByText('SLA: Standard')).toBeInTheDocument();
    expect(steps.getByText('A new contact')).toBeInTheDocument();
    expect(steps.getByText('Would stay unassigned')).toBeInTheDocument();
  });

  it('shows the condition that stopped a rule from matching', async () => {
    await run(async (user) => {
      await user.type(screen.getByLabelText('From'), 'someone@example.com');
      await user.type(screen.getByLabelText('Subject'), 'Refund for invoice 2207');
    });

    const result = await screen.findByRole('heading', { name: 'Result' }, LOAD);
    const steps = within(result.parentElement as HTMLElement);
    expect(await steps.findByText('Rule “Refunds to Billing” doesn’t match')).toBeInTheDocument();
    expect(steps.getByText('Would assign to Omar Aziz now')).toBeInTheDocument();
    expect(steps.getByText('Round-robin in Billing.')).toBeInTheDocument();
  });

  it('stops at a blocked sender with a warning and no steps after it', async () => {
    await run(async (user) => {
      await user.type(screen.getByLabelText('From'), MOCK_ROUTING.senders.blocked);
    });

    expect(await screen.findByText(/is on the block list/, {}, LOAD)).toHaveTextContent(
      'A real message would be dropped and counted, and no ticket would be created.',
    );
    expect(screen.queryByText('AI triage would be queued')).not.toBeInTheDocument();
  });

  it('says no ticket would be created for an automated sender', async () => {
    await run(async (user) => {
      await user.type(screen.getByLabelText('From'), MOCK_ROUTING.senders.automated);
    });

    expect(await screen.findByText(/is an automated sender/, {}, LOAD)).toHaveTextContent(
      'No ticket would be created.',
    );
  });

  it('says nobody is online when the department’s people are all away', async () => {
    await run(async (user) => {
      await user.type(screen.getByLabelText('From'), MOCK_ROUTING.senders.away);
    });

    expect(await screen.findByText('Nobody in Billing is online', {}, LOAD)).toBeInTheDocument();
  });

  it('names the department an API request files into', async () => {
    const { user } = await run(async (user) => {
      await user.selectOptions(screen.getByLabelText('Channel and entry point'), 'api_key:');
    });

    expect(
      await screen.findByLabelText('Department the request names', {}, LOAD),
    ).toBeInTheDocument();
    expect(user).toBeDefined();
  });

  it('says the test could not run, and keeps what was typed', async () => {
    await run(async (user) => {
      await user.type(screen.getByLabelText('From'), MOCK_ROUTING.senders.failing);
    });

    expect(
      await screen.findByText('The test could not run. Try again.', {}, LOAD),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveValue(MOCK_ROUTING.senders.failing);
    expect(screen.queryByRole('heading', { name: 'Result' })).not.toBeInTheDocument();
  });
});
