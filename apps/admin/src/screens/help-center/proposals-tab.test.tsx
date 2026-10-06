import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { helpCenterRoute } from '../../app/route-paths.js';
import { AppRoutes } from '../../app/routes.tsx';
import { MockAssistApi } from '../../assist/mock-api.js';
import { MOCK_HELP_CENTER, MockHelpCenterApi } from '../../help-center/mock-api.js';
import { renderApp } from '../../test/render.tsx';
import { signedInMockApis } from '../../test/signed-in.js';
import { MOCK_TICKET_CLOSED, MockTicketsApi } from '../../tickets/mock-api.js';

/**
 * Help center › Proposals (M7-05, `Admin/HelpCenter-ArticleApproval`):
 * reviewing an article drafted from a ticket, approving it into the editor
 * and rejecting it with a reason.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

const openProposals = async () => {
  const apis = await signedInMockApis();
  const tickets = new MockTicketsApi();
  const helpCenter = new MockHelpCenterApi();
  const assistApi = new MockAssistApi({ tickets, helpCenter });
  await assistApi.propose(BRAND, MOCK_TICKET_CLOSED, {
    sectionId: MOCK_HELP_CENTER.sections.delivery,
    locale: 'en',
    title: 'Customs and VAT on clothing shipped to Germany',
    bodyMarkdown: 'Duty is not charged under €150.\n\n## Who handles clearance\n\nWe do.',
    note: 'Third customs question this week.',
    callId: null,
    messageCount: 7,
    citations: [{ title: 'Customs and duties for EU deliveries', articleId: null }],
  });
  const rendered = renderApp(<AppRoutes />, {
    authApi: apis.auth,
    staffApi: apis.staff,
    ticketsApi: tickets,
    helpCenterApi: helpCenter,
    assistApi,
    initialEntries: [helpCenterRoute('proposals')],
  });
  const review = await screen.findByRole('region', { name: 'Review proposal' });
  return { ...rendered, assistApi, review };
};

describe('Help center › Proposals', () => {
  it('lists what is waiting and shows the draft with where it would go', async () => {
    const { review } = await openProposals();

    expect(screen.getByRole('tab', { name: /Proposals 1/ })).toBeVisible();
    expect(
      within(review).getByRole('heading', {
        name: 'Customs and VAT on clothing shipped to Germany',
      }),
    ).toBeVisible();
    expect(within(review).getByText('Who handles clearance')).toBeVisible();
    expect(within(review).getByText('Third customs question this week.')).toBeVisible();
    expect(within(review).getByText('Customs and duties for EU deliveries')).toBeVisible();
  });

  it('approves into a draft article and opens it in the editor', async () => {
    const { user, review } = await openProposals();

    await user.click(within(review).getByRole('radio', { name: 'Internal' }));
    await user.click(within(review).getByRole('button', { name: 'Approve and open in editor' }));

    expect(await screen.findByText('Draft article created.')).toBeVisible();
    expect(
      await screen.findByDisplayValue('Customs and VAT on clothing shipped to Germany', undefined, {
        timeout: 5_000,
      }),
    ).toBeVisible();
  });

  it('rejects with a reason, which is required', async () => {
    const { user, review, assistApi } = await openProposals();

    await user.click(within(review).getByRole('button', { name: 'Reject…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this proposal?' });
    const submit = within(dialog).getByRole('button', { name: 'Reject' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Already covered.');
    await user.click(submit);

    expect(await screen.findByText('Proposal rejected.')).toBeVisible();
    const decided = await assistApi.proposals(BRAND, { status: 'decided' });
    expect(decided.items[0]?.status).toBe('rejected');
  });
});
