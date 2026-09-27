import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../../app/routes.tsx';
import { MOCK_AUTOMATION, MOCK_RULE_IDS, MockAutomationApi } from '../../../automation/mock-api.js';
import { renderApp } from '../../../test/render.tsx';
import { signedInMockApis } from '../../../test/signed-in.js';

/**
 * `Admin/Automation` against the fixture, whose signed-in user is an Admin:
 * the list, its order and its switches, the execution log and the depth-guard
 * loop in it, the builder, and the test run.
 */

const renderAt = async (path: string, automation = new MockAutomationApi()) => {
  const { auth, staff, ticketing } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    ticketingApi: ticketing,
    automationApi: automation,
    initialEntries: [path],
  });
  return { ...rendered, automation };
};

/** The first screen of a file pays for the app's start, on a busy runner too. */
const LOAD = { timeout: 5_000 };

const ruleList = (): HTMLElement =>
  screen.getByRole('list', { name: 'Workflow rules, in the order they run' });

const ruleNames = (): string[] =>
  within(ruleList())
    .getAllByRole('link')
    .map((link) => link.querySelector('span')?.textContent ?? '');

describe('the Rules tab', () => {
  it('lists the event rules in the order they run, with what each does', async () => {
    await renderAt('/admin/automation');

    await screen.findByRole('list', { name: 'Workflow rules, in the order they run' }, LOAD);
    expect(screen.getByRole('tab', { name: 'Rules', selected: true })).toBeInTheDocument();
    expect(ruleNames()).toEqual([
      'Refunds to Billing',
      'Telegram to Sales',
      'Invoices to Returns',
      'Returns back to Billing',
      'VIP tag raises priority',
      'Escalate on SLA breach',
      'Web form to Sales',
    ]);
    expect(
      await screen.findByText(
        'If Subject contains “refund” (+3 conditions) → Assign to team Billing, Reply “Refund received”, Add tag refund, Notify Department team leads',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable Web form to Sales' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('names the rules in a loop the depth guard stopped today', async () => {
    await renderAt('/admin/automation/rules');

    const banner = (await screen.findByText(/keep setting each other off/, {}, LOAD)).closest(
      '[role="status"]',
    );
    expect(banner).toHaveTextContent('Invoices to Returns and Returns back to Billing');
    expect(banner).toHaveTextContent('HD-1041');
  });

  it('turns a rule off from its switch', async () => {
    const { user, automation } = await renderAt('/admin/automation/rules');
    const toggle = vi.spyOn(automation, 'setRuleEnabled');

    await user.click(await screen.findByRole('switch', { name: 'Enable Telegram to Sales' }, LOAD));

    expect(toggle).toHaveBeenCalledWith(expect.any(String), MOCK_RULE_IDS[1], false);
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Enable Telegram to Sales' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });
  });

  it('moves a rule with the keyboard and sends the whole order', async () => {
    const { user, automation } = await renderAt('/admin/automation/rules');
    const reorder = vi.spyOn(automation, 'reorderRules');

    const handle = await screen.findByRole('button', { name: 'Reorder Telegram to Sales' }, LOAD);
    handle.focus();
    await user.keyboard('{ArrowUp}');

    expect(reorder).toHaveBeenCalledWith(expect.any(String), 'event', [
      MOCK_RULE_IDS[1],
      MOCK_RULE_IDS[0],
      ...MOCK_RULE_IDS.slice(2, 7),
    ]);
    await waitFor(() => {
      expect(ruleNames().slice(0, 2)).toEqual(['Telegram to Sales', 'Refunds to Billing']);
    });
  });

  it('deletes a rule after asking', async () => {
    const { user } = await renderAt('/admin/automation/rules');

    await user.click(
      await screen.findByRole('button', { name: 'Actions for Web form to Sales' }, LOAD),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete rule' }));

    await waitFor(() => {
      expect(ruleNames()).not.toContain('Web form to Sales');
    });
  });
});

describe('the execution log', () => {
  it('opens a stopped run into the chain that led to it', async () => {
    await renderAt('/admin/automation/rules');

    const log = await screen.findByRole('list', { name: 'Rule runs, newest first' }, LOAD);
    await within(log).findByText('Cycle found at depth 3 of 3', {}, LOAD);
    expect(within(log).getByText('Invoices to Returns ran')).toBeInTheDocument();
    expect(
      within(log).getByText('Invoices to Returns would run again, so it was stopped before acting'),
    ).toBeInTheDocument();
    expect(
      within(log).getByText(/channel is Email|Channel is Telegram did not match: Email/),
    ).toBeInTheDocument();
  });

  it('filters by result', async () => {
    const { user } = await renderAt('/admin/automation/rules');
    const log = await screen.findByRole('list', { name: 'Rule runs, newest first' }, LOAD);
    await within(log).findAllByText('Applied');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Result' }), 'skipped');

    await waitFor(() => {
      expect(within(log).queryByText('Applied')).not.toBeInTheDocument();
    });
    expect(within(log).getByText('Skipped')).toBeInTheDocument();
  });
});

describe('the Time-based and Macros tabs', () => {
  it('lists the scheduled rules with their interval', async () => {
    await renderAt('/admin/automation/time-based');

    const list = await screen.findByRole(
      'list',
      { name: 'Time-based rules, in the order they run' },
      LOAD,
    );
    expect(within(list).getByText('Close after 3 days awaiting customer')).toBeInTheDocument();
    expect(within(list).getByText('15 minutes')).toBeInTheDocument();
  });

  it('lists macros and canned responses under Macros, with no New rule', async () => {
    await renderAt('/admin/automation/macros');

    expect(await screen.findByRole('button', { name: /Refund issued/ }, LOAD)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Macros', selected: true })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'New rule' })).not.toBeInTheDocument();
  });
});

describe('the builder', () => {
  it('opens a saved rule with its conditions and actions', async () => {
    await renderAt(`/admin/automation/rules/${MOCK_RULE_IDS[0] ?? ''}`);

    expect(
      await screen.findByRole('form', { name: 'Edit rule Refunds to Billing' }, LOAD),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Rule name · required')).toHaveValue('Refunds to Billing');
    expect(screen.getByRole('combobox', { name: 'Event' })).toHaveValue('ticket_created');
    expect(
      screen
        .getAllByRole('textbox', { name: 'Text' })
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(['refund', 'استرداد']);
    expect(screen.getByRole('checkbox', { name: /Counts as first response/ })).not.toBeChecked();
  });

  it('refuses to save an incomplete rule, and saves it once it is whole', async () => {
    const { user, automation } = await renderAt('/admin/automation/rules/new?kind=event');
    const create = vi.spyOn(automation, 'createRule');

    await user.click(await screen.findByRole('button', { name: 'Save rule' }, LOAD));
    expect(
      await screen.findByText('Fill in every condition and action before saving.'),
    ).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Rule name · required'), 'Urgent to Technical');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Field' }), 'priority');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Value' }), 'urgent');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Team' }),
      MOCK_AUTOMATION.teams.technical,
    );
    await user.click(screen.getByRole('button', { name: 'Save rule' }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          name: 'Urgent to Technical',
          kind: 'event',
          trigger: 'ticket_created',
          actions: [{ type: 'assign_team', teamId: MOCK_AUTOMATION.teams.technical }],
        }),
      );
    }, LOAD);
  });

  it('turns an event rule into a scheduled one', async () => {
    const { user } = await renderAt('/admin/automation/rules/new?kind=event');

    await user.click(await screen.findByRole('button', { name: 'On a schedule' }, LOAD));

    expect(screen.getByRole('combobox', { name: 'Every' })).toHaveValue('15');
    expect(screen.queryByRole('combobox', { name: 'Event' })).not.toBeInTheDocument();
  });
});

describe('the test run', () => {
  it('says what the draft would do to a sample ticket, and what it could set off', async () => {
    const { user } = await renderAt(`/admin/automation/rules/${MOCK_RULE_IDS[0] ?? ''}`);

    await user.type(await screen.findByLabelText('Sample ticket', {}, LOAD), 'HD-1042');
    await user.click(screen.getByRole('button', { name: 'Run test' }));

    expect(await screen.findByText('This rule would run on HD-1042.')).toBeInTheDocument();
    expect(screen.getByText('found in “Refund not received after 10 days”')).toBeInTheDocument();
    expect(screen.getByText('already so, no change')).toBeInTheDocument();
    expect(screen.getByText('first-response clock keeps running')).toBeInTheDocument();
    expect(screen.getByText('Assigned → Invoices to Returns at depth 2')).toBeInTheDocument();
  });

  it('says so when the ticket is not one the reader can see', async () => {
    const { user } = await renderAt(`/admin/automation/rules/${MOCK_RULE_IDS[0] ?? ''}`);

    await user.type(await screen.findByLabelText('Sample ticket', {}, LOAD), 'HD-9999');
    await user.click(screen.getByRole('button', { name: 'Run test' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No ticket HD-9999 in the Helpdock brand, or you cannot see it.',
    );
    expect(screen.getByLabelText('Sample ticket')).toHaveAttribute('aria-invalid', 'true');
  });

  it('says why a draft would not run', async () => {
    const { user } = await renderAt(`/admin/automation/rules/${MOCK_RULE_IDS[0] ?? ''}`);

    await user.type(await screen.findByLabelText('Sample ticket', {}, LOAD), 'HD-1039');
    await user.click(screen.getByRole('button', { name: 'Run test' }));

    expect(await screen.findByText('This rule would not run on HD-1039.')).toBeInTheDocument();
    expect(screen.queryByText('Would do')).not.toBeInTheDocument();
  });
});
