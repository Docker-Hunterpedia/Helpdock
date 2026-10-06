import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MockAiApi } from '../../../../ai/mock-api.js';
import { AppRoutes } from '../../../../app/routes.tsx';
import { MOCK_BRANDS } from '../../../../auth/mock-api.js';
import { renderApp } from '../../../../test/render.tsx';
import { signedInMockApis } from '../../../../test/signed-in.js';
import { limitOf } from './budget-card.tsx';

/**
 * AI › Assistant (`Admin/AI-Assistant`) against the fixture, whose first
 * brand is at its monthly hard stop: the banner, the modes with their
 * thresholds, the guardrails, the budget meters and limits, the prompt in two
 * languages and the activity list.
 */

const BRAND = MOCK_BRANDS[0]?.id ?? '';

const renderAssistant = async (aiApi = new MockAiApi()) => {
  const { auth, staff } = await signedInMockApis();
  const rendered = renderApp(<AppRoutes />, {
    authApi: auth,
    staffApi: staff,
    aiApi,
    initialEntries: ['/admin/ai/assistant'],
  });
  await screen.findByRole('region', { name: 'Modes' });
  return { ...rendered, aiApi };
};

const card = (name: string): HTMLElement => screen.getByRole('region', { name });

describe('AI › Assistant', () => {
  it('says auto-reply is stopped by the budget, pauses the channels, and offers to raise the limit', async () => {
    const { user } = await renderAssistant();

    expect(screen.getByRole('alert')).toHaveTextContent(/Budget reached — auto-reply is off until/);
    expect(within(card('Modes')).getAllByText('Paused · budget')).toHaveLength(2);
    expect(
      within(card('Budget')).getByRole('progressbar', { name: 'Monthly spend 100 %' }),
    ).toHaveAttribute('aria-valuenow', '100');

    await user.click(screen.getByRole('button', { name: 'Raise limit' }));
    expect(within(card('Budget')).getByLabelText('Monthly limit (USD)')).toHaveFocus();
  });

  it('turns email auto-reply on with a threshold and saves the modes', async () => {
    const { user, aiApi } = await renderAssistant();
    const save = vi.spyOn(aiApi, 'saveModes');
    const modes = card('Modes');

    expect(within(modes).getByText('Off · replies come from people only')).toBeVisible();
    await user.click(within(modes).getByRole('switch', { name: 'Auto-reply on Email' }));
    fireEvent.change(within(modes).getByRole('slider', { name: 'Email confidence threshold' }), {
      target: { value: '0.85' },
    });
    expect(within(modes).getAllByText('0.85')).toHaveLength(1);
    await user.click(within(modes).getByRole('button', { name: 'Save modes' }));

    expect(save).toHaveBeenCalledWith(
      BRAND,
      expect.objectContaining({
        autoReply: expect.objectContaining({ email: { enabled: true, threshold: 0.85 } }),
        aiCountsAsFirstResponse: true,
      }),
    );
    expect(await screen.findByText('Modes saved.')).toBeVisible();
  });

  it('keeps PII redaction on and lets the injection filter be turned off', async () => {
    const { user, aiApi } = await renderAssistant();
    const save = vi.spyOn(aiApi, 'saveBrandSettings');
    const guardrails = card('Guardrails');

    expect(within(guardrails).getAllByText('Always on')).toHaveLength(2);
    await user.click(
      within(guardrails).getByRole('switch', { name: 'Injection filter on ingested content' }),
    );

    expect(save).toHaveBeenCalledWith(
      BRAND,
      expect.objectContaining({ piiRedaction: true, injectionFilter: false }),
    );
  });

  it('refuses a limit of zero under its field', async () => {
    const { user } = await renderAssistant();
    const budget = card('Budget');
    const daily = within(budget).getByLabelText('Daily limit (USD)');

    await user.clear(daily);
    await user.type(daily, '0');
    await user.click(within(budget).getByRole('button', { name: 'Save budget' }));

    expect(within(budget).getByText('Enter an amount above 0, or leave it empty.')).toBeVisible();
  });

  it('saves the Arabic prompt beside the English one', async () => {
    const { user, aiApi } = await renderAssistant();
    const save = vi.spyOn(aiApi, 'savePrompt');
    const prompt = card('System prompt');

    await user.click(within(prompt).getByRole('button', { name: 'العربية' }));
    await user.type(
      within(prompt).getByLabelText('Prompt for Arabic conversations'),
      'أجب بإيجاز.',
    );
    await user.click(within(prompt).getByRole('button', { name: 'Save prompt' }));

    expect(save).toHaveBeenCalledWith(BRAND, {
      systemPrompt: expect.stringContaining('You are the support assistant'),
      systemPromptAr: 'أجب بإيجاز.',
    });
  });

  it('lists the brand’s AI calls a page at a time', async () => {
    const { user } = await renderAssistant();
    const activity = card('AI activity');
    const list = await within(activity).findByRole('list', { name: 'AI calls' });

    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    expect(within(list).getByText(/skipped · budget/)).toBeVisible();
    expect(within(list).getByRole('link', { name: 'HD-1061' })).toBeVisible();

    await user.click(within(activity).getByRole('button', { name: 'Load more' }));
    expect(await within(list).findByRole('link', { name: 'HD-1035' })).toBeVisible();
    expect(within(activity).queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('limitOf', () => {
  it('reads empty as no limit and refuses zero, negatives and words', () => {
    expect(limitOf('')).toBeNull();
    expect(limitOf('12.5')).toBe(12.5);
    expect(limitOf('0')).toBe('invalid');
    expect(limitOf('-1')).toBe('invalid');
    expect(limitOf('ten')).toBe('invalid');
  });
});
