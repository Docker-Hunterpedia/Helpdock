import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistantAnswering } from '../state/thread.js';
import { renderWidget, withIsolates } from '../test/render.js';
import { LINA, SAMPLE_AI_ANSWER, SAMPLE_AI_HANDOFF } from '../transport/fixtures.js';
import type { MockOptions } from '../transport/mock.js';
import type { WidgetMessage } from '../transport/types.js';
import { handoffPosition } from './Thread.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

    expect(screen.getByText('Thanks, that helps us improve.')).toBeTruthy();
    // The thread's log announces it; a status of its own inside the log would be read twice.
    expect(screen.queryByRole('status')).toBeNull();
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
      within(log).getByText(withIsolates(/A person will reply here and at omar\.k@example\.com\./)),
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

describe('the handoff line out of hours (M7-06, Widget/AI-EN panel 6)', () => {
  // Friday 21:40 in Dubai; the fixture's team opens on Sunday at 09:00 there.
  const FRIDAY_EVENING = new Date('2026-09-25T17:40:00Z');
  const OPENING_MS = new Date('2026-09-27T05:00:00Z').getTime();
  const HANDOFF = { kind: 'handoff', citations: [], feedback: null } as const;

  const awayStarted = async (locale: 'en' | 'ar' = 'en', mock: Partial<MockOptions> = {}) => {
    vi.useFakeTimers({ now: FRIDAY_EVENING });
    const widget = await renderWidget({ locale, availability: 'closed', mock });
    fireEvent.click(screen.getByRole('button', { name: widget.t('launcher.open') }));
    await act(() => widget.controller.startConversation({ email: 'omar.k@example.com' }));
    return widget;
  };

  const talkToHuman = async (locale: 'en' | 'ar' = 'en', mock: Partial<MockOptions> = {}) => {
    const widget = await awayStarted(locale, mock);
    await answer(widget.mock, locale);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: widget.t('ai.talkToHuman') }));
    });
    return widget;
  };

  const handoffLine = (): HTMLElement => {
    const line = screen.getByRole('log').querySelector<HTMLElement>('li.hd-handoff');
    if (line === null) {
      throw new Error('no handoff line in the log');
    }
    return line;
  };
  const title = () => handoffLine().querySelector('strong')?.textContent;
  const drawsMoon = (line: HTMLElement) => line.querySelector('path[d^="M12 3a6 6"]') !== null;
  const drawsHeadset = (line: HTMLElement) => line.querySelector('path[d^="M3 11h3"]') !== null;

  it('says the team is away until Sunday and where the reply will arrive, after "Talk to a human"', async () => {
    await talkToHuman();

    const line = handoffLine();
    expect(line.textContent).toBe(
      'The team is away until Sunday at 09:00 (Gulf Standard Time)' +
        'Your message is saved. A person will reply here and at omar.k@example.com when the team is back.',
    );
    expect(title()).toBe('The team is away until Sunday at 09:00 (Gulf Standard Time)');
    expect(drawsMoon(line)).toBe(true);
    expect(drawsHeadset(line)).toBe(false);
    expect(line.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(line.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Talk to a human' })).toBeNull();
  });

  it("words the same line when the assistant's own handoff text arrives", async () => {
    const { mock } = await awayStarted();

    act(() => {
      mock.aiReply(SAMPLE_AI_HANDOFF.en, HANDOFF);
    });

    expect(within(screen.getByRole('log')).getByText(SAMPLE_AI_HANDOFF.en)).toBeTruthy();
    expect(title()).toBe('The team is away until Sunday at 09:00 (Gulf Standard Time)');
    expect(drawsMoon(handoffLine())).toBe(true);
  });

  it('reads "away right now" for a calendar that never opens', async () => {
    await talkToHuman('en', { hours: { open: false, next_open_at: null, timezone: 'Asia/Dubai' } });

    expect(title()).toBe('The team is away right now');
    expect(handoffLine().textContent).toContain('Your message is saved.');
    expect(drawsMoon(handoffLine())).toBe(true);
  });

  it("falls back to the brand's availability from a server that sends no hours", async () => {
    await talkToHuman('en', { hours: null });

    expect(title()).toBe('The team is away until Sunday at 09:00 (Gulf Standard Time)');
  });

  it('keeps the ordinary line when the team that answers is open, whatever the brand does', async () => {
    await talkToHuman('en', { hours: { open: true, next_open_at: null, timezone: 'Asia/Dubai' } });

    expect(title()).toBe('Connecting you with the team…');
    expect(drawsHeadset(handoffLine())).toBe(true);
  });

  it('turns back into the ordinary line once a person has answered', async () => {
    const { mock } = await talkToHuman();
    const away = handoffLine();

    act(() => {
      mock.agentReply(LINA, 'Hi, Lina here.');
    });

    const line = handoffLine();
    expect(line).not.toBe(away);
    expect(title()).toBe('Connecting you with the team…');
    expect(drawsHeadset(line)).toBe(true);
    expect(drawsMoon(line)).toBe(false);
  });

  it('turns back into the ordinary line at the opening, as a new entry for the log to read', async () => {
    await talkToHuman();
    const away = handoffLine();

    act(() => {
      vi.advanceTimersByTime(OPENING_MS - FRIDAY_EVENING.getTime() - 1_000);
    });
    expect(handoffLine()).toBe(away);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(handoffLine()).not.toBe(away);
    expect(away.isConnected).toBe(false);
    expect(title()).toBe('Connecting you with the team…');
  });

  it('reads the header and the strip from the hours of the team that answers', async () => {
    // A department that opens on Monday in Riyadh, while the brand opens on Sunday in Dubai.
    await awayStarted('en', {
      hours: { open: false, next_open_at: '2026-09-28T06:00:00Z', timezone: 'Asia/Riyadh' },
    });

    expect(screen.getByText('Back Monday at 09:00')).toBeTruthy();
    expect(screen.getByText(/We open Monday at 09:00 \(Arabian Standard Time\)/)).toBeTruthy();
  });

  it('speaks Arabic, with the time and the email isolated for the right-to-left sentence', async () => {
    await talkToHuman('ar');

    const line = handoffLine();
    expect(title()).toBe('فريق الدعم غير متاح حتى الأحد الساعة 09:00 (توقيت الخليج)');
    expect(line.textContent).toContain(
      'رسالتك محفوظة، وسيرد عليك موظف هنا وعلى omar.k@example.com عند عودة الفريق.',
    );
    expect([...line.querySelectorAll('bdi')].map((isolate) => isolate.textContent)).toEqual([
      'الأحد',
      '09:00',
      'توقيت الخليج',
      'omar.k@example.com',
    ]);
    expect(line.querySelector('.hd-mirror')).toBeNull();
  });

  it('words the day by how many days away the opening is, in the team’s zone', async () => {
    const opensAt = (next_open_at: string): Partial<MockOptions> => ({
      hours: { open: false, next_open_at, timezone: 'Asia/Dubai' },
    });

    await talkToHuman('en', opensAt('2026-09-26T05:00:00Z'));
    expect(title()).toBe('The team is away until tomorrow at 09:00 (Gulf Standard Time)');
    cleanup();

    await talkToHuman('en', opensAt('2026-10-04T05:00:00Z'));
    expect(title()).toBe('The team is away until 4 October at 09:00 (Gulf Standard Time)');
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
