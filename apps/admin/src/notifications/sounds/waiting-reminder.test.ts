import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaitingChatReminders } from './waiting-reminder.js';

const MINUTE = 60_000;

const harness = (answers: Record<string, boolean | Error> = {}) => {
  const reminded: string[] = [];
  const reminders = new WaitingChatReminders({
    intervalMs: MINUTE,
    stillWaiting: async (id) => {
      const answer = answers[id] ?? true;
      if (answer instanceof Error) throw answer;

      return answer;
    },
    remind: (id) => reminded.push(id),
  });

  return { reminders, reminded, answers };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the waiting-chat reminder', () => {
  it('rings once a minute while the chat waits', async () => {
    const { reminders, reminded } = harness();
    reminders.track('chat-1');

    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(reminded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(reminded).toEqual(['chat-1', 'chat-1']);
  });

  it('stops for good when the chat is picked up', async () => {
    const { reminders, reminded, answers } = harness();
    reminders.track('chat-1');
    await vi.advanceTimersByTimeAsync(MINUTE);

    answers['chat-1'] = false;
    await vi.advanceTimersByTimeAsync(MINUTE);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(reminded).toEqual(['chat-1']);
    expect(reminders.has('chat-1')).toBe(false);
  });

  it('stops at once when released, even with a read in flight', async () => {
    let resolve: (waiting: boolean) => void = () => undefined;
    const reminded: string[] = [];
    const reminders = new WaitingChatReminders({
      intervalMs: MINUTE,
      stillWaiting: () => new Promise<boolean>((done) => (resolve = done)),
      remind: (id) => reminded.push(id),
    });
    reminders.track('chat-1');
    await vi.advanceTimersByTimeAsync(MINUTE);

    reminders.release('chat-1');
    resolve(true);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(reminded).toEqual([]);
  });

  it('keeps one timer per chat however often it is tracked, and tracks chats separately', async () => {
    const { reminders, reminded } = harness();
    reminders.track('chat-1');
    reminders.track('chat-1');
    reminders.track('chat-2');
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect([...reminded].sort()).toEqual(['chat-1', 'chat-2']);
    reminders.release('chat-1');
    expect(reminders.ids()).toEqual(['chat-2']);
  });

  it('survives one failed read, and gives up on a chat that can no longer be read', async () => {
    const { reminders, reminded, answers } = harness({ 'chat-1': new Error('down') });
    reminders.track('chat-1');

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(reminders.has('chat-1')).toBe(true);
    answers['chat-1'] = true;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(reminded).toEqual(['chat-1']);

    answers['chat-1'] = new Error('gone');
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(reminders.has('chat-1')).toBe(false);
  });

  it('clear() stops every chat', async () => {
    const { reminders, reminded } = harness();
    reminders.track('chat-1');
    reminders.track('chat-2');
    reminders.clear();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(reminded).toEqual([]);
    expect(reminders.ids()).toEqual([]);
  });
});
