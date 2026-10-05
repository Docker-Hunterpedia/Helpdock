import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { assistantAnswering } from '../state/thread.js';
import { renderWidget } from '../test/render.js';
import { LINA, SAMPLE_AI_ANSWER, SAMPLE_AI_HANDOFF } from '../transport/fixtures.js';
import type { WidgetMessage } from '../transport/types.js';
import { handoffPosition } from './Thread.js';

afterEach(cleanup);

const started = async (locale: 'en' | 'ar' = 'en') => {
  const widget = await renderWidget({ locale });
  fireEvent.click(screen.getByRole('button', { name: widget.t('launcher.open') }));
  await act(() => widget.controller.startConversation({ email: 'omar.k@example.com' }));
  return widget;
};

const answer = (mock: Awaited<ReturnType<typeof started>>['mock'], locale: 'en' | 'ar' = 'en') =>
  act(() => {
    mock.aiReply(SAMPLE_AI_ANSWER[locale].body, SAMPLE_AI_ANSWER[locale].ai);
  });

describe('the assistant in the thread (M7-06, Widget/AI-EN board 1)', () => {
  it('names the answer in words with the AI badge, and links each citation to its source', async () => {
    const { mock } = await started();
    await answer(mock);
    const log = screen.getByRole('log', { name: 'Messages' });

    expect(within(log).getByText('Helpdock assistant')).toBeTruthy();
    expect(within(log).getByText('AI')).toBeTruthy();
    const cite = within(log).getByRole('link', { name: 'Source 1, Refund timelines' });
    expect(cite.textContent).toBe('[1]');
    const sources = within(log).getByRole('list', { name: 'Sources' });
    expect(
      within(sources)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['1Refund timelines', '2Returns and refunds policy']);

    fireEvent.click(cite);
    expect(document.activeElement?.textContent).toBe('1Refund timelines');
  });

  it('opens a cited article in the window', async () => {
    const { mock } = await started();
    await answer(mock);

    const sources = screen.getByRole('list', { name: 'Sources' });
    fireEvent.click(within(sources).getAllByRole('link')[0] as HTMLElement);

    expect(await screen.findByRole('heading', { name: 'Refund timelines' })).toBeTruthy();
  });

  it('asks "Was this helpful?" once and thanks the visitor', async () => {
    const { mock } = await started();
    await answer(mock);
    const group = screen.getByRole('group', { name: 'Was this helpful?' });

    fireEvent.click(within(group).getByRole('button', { name: 'Yes, helpful' }));

    expect(screen.getByRole('status').textContent).toContain('Thanks, that helps us improve.');
    expect(screen.queryByRole('group', { name: 'Was this helpful?' })).toBeNull();
    expect(mock.calls.find((call) => call.method === 'sendFeedback')?.args).toEqual([
      'conversation-1',
      'message-1',
      'helpful',
    ]);
  });

  it('offers "Talk to a human" while it answers, and hands off for good when pressed', async () => {
    const { mock } = await started();
    expect(screen.queryByRole('button', { name: 'Talk to a human' })).toBeNull();
    await answer(mock);

    fireEvent.click(screen.getByRole('button', { name: 'Talk to a human' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Talk to a human' })).toBeNull(),
    );
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(within(log).getByText('Connecting you with the team…')).toBeTruthy();
    expect(
      within(log).getByText(/A person will reply here and at omar\.k@example\.com\./),
    ).toBeTruthy();
    expect(mock.calls.some((call) => call.method === 'handOff')).toBe(true);
  });

  it("draws the brand's handoff text in the assistant bubble, then the line (board 3)", async () => {
    const { mock } = await started();

    act(() => {
      mock.aiReply(SAMPLE_AI_HANDOFF.en, { kind: 'handoff', citations: [], feedback: null });
    });

    const log = screen.getByRole('log', { name: 'Messages' });
    expect(within(log).getByText(SAMPLE_AI_HANDOFF.en)).toBeTruthy();
    expect(within(log).getByText('Connecting you with the team…')).toBeTruthy();
    expect(within(log).queryByRole('group', { name: 'Was this helpful?' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Talk to a human' })).toBeNull();
  });

  it('marks nothing as AI when the assistant never answered (board 5)', async () => {
    const { mock } = await started();
    act(() => {
      mock.agentReply(LINA, 'Hi, Lina here.');
    });

    expect(screen.queryByText('AI')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Talk to a human' })).toBeNull();
    expect(screen.queryByText('Connecting you with the team…')).toBeNull();
  });

  it('speaks Arabic in an Arabic window', async () => {
    const { mock } = await started('ar');
    await answer(mock, 'ar');

    expect(screen.getByText('مساعد Helpdock')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'المصدر 1، مدة استرداد المبالغ' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'التحدث مع موظف' })).toBeTruthy();
  });
});

const message = (author: WidgetMessage['author'], ai?: WidgetMessage['ai']): WidgetMessage => ({
  id: `m-${Math.random()}`,
  conversation_id: 'c',
  seq: 1,
  client_id: null,
  author,
  body: '',
  attachments: [],
  system: null,
  ...(ai === undefined ? {} : { ai }),
  created_at: '2026-10-05T09:41:00Z',
});
const visitor = message({ kind: 'visitor' });
const aiAnswer = message({ kind: 'ai' }, { kind: 'answer', citations: [], feedback: null });
const aiHandoff = message({ kind: 'ai' }, { kind: 'handoff', citations: [], feedback: null });
const agent = message({ kind: 'agent', agent: LINA });

describe('handoffPosition', () => {
  it('is nowhere while the assistant has the conversation', () => {
    expect(handoffPosition([visitor, aiAnswer], false)).toBe(-1);
  });

  it('follows the handoff message', () => {
    expect(handoffPosition([visitor, aiHandoff, visitor], true)).toBe(2);
  });

  it('comes before the first person to answer after the assistant, or at the end', () => {
    expect(handoffPosition([visitor, aiAnswer, visitor, agent], true)).toBe(3);
    expect(handoffPosition([visitor, aiAnswer, visitor], true)).toBe(3);
  });
});

describe('assistantAnswering', () => {
  const thread = (confirmed: WidgetMessage[]) => ({
    confirmed,
    pending: [],
    lastSeq: 0,
    readSeq: 0,
  });

  it('is while its answer is the last word from the other side', () => {
    expect(assistantAnswering(thread([visitor, aiAnswer, visitor]), false)).toBe(true);
  });

  it('is not once handed off, after its handoff text, or once a person answered', () => {
    expect(assistantAnswering(thread([visitor, aiAnswer]), true)).toBe(false);
    expect(assistantAnswering(thread([visitor, aiHandoff]), false)).toBe(false);
    expect(assistantAnswering(thread([visitor, aiAnswer, agent]), false)).toBe(false);
  });
});
