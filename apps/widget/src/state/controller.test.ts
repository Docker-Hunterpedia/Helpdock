import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LINA,
  type SampleOptions,
  sampleAvailability,
  sampleMockOptions,
} from '../transport/fixtures.js';
import { MockTransport } from '../transport/mock.js';
import type { ConversationSummary, WidgetMessage } from '../transport/types.js';
import { WidgetController } from './controller.js';

const settle = () => vi.waitFor(() => undefined);
const flush = async () => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

async function setup(options: SampleOptions = {}, resume?: MockTransport['messages']) {
  const mock = new MockTransport({
    ...sampleMockOptions('en', options),
    ...(resume
      ? {
          resume: {
            conversation: {
              id: 'conversation-1',
              status: 'active',
              agent: LINA,
              department: 'Billing',
              visitor_email: 'omar@example.com',
              read_seq: 1,
            } satisfies ConversationSummary,
            messages: [...resume],
          },
        }
      : {}),
  });
  const controller = new WidgetController(mock, 'en');
  await controller.init();
  await flush();
  return { mock, controller };
}

const visitorMessages = (mock: MockTransport) =>
  mock.messages.filter((message) => message.author.kind === 'visitor');

afterEach(() => {
  vi.useRealTimers();
});

describe('WidgetController start-up', () => {
  it('loads the config and the session, and stays out of a conversation until the visitor writes', async () => {
    const { controller, mock } = await setup();

    expect(controller.state.status).toBe('ready');
    expect(controller.state.conversation).toBeNull();
    expect(controller.state.connection).toBe('online');
    expect(mock.calls.map((call) => call.method)).toEqual([
      'getConfig',
      'startSession',
      'subscribe',
    ]);
    expect(mock.calls[1]?.args).toEqual([null]);
  });

  it('resumes an open conversation and loads its thread from the beginning', async () => {
    const agentLine: WidgetMessage = {
      id: 'm1',
      conversation_id: 'conversation-1',
      seq: 1,
      client_id: null,
      author: { kind: 'agent', agent: LINA },
      body: 'Welcome back',
      attachments: [],
      system: null,
      created_at: '2026-09-27T09:00:00Z',
    };
    const { controller, mock } = await setup({}, [agentLine]);

    expect(controller.state.thread.confirmed).toHaveLength(1);
    expect(controller.state.thread.lastSeq).toBe(1);
    expect(mock.calls).toContainEqual({ method: 'listMessages', args: ['conversation-1', 0] });
  });

  it('reports failure when the config cannot load, so the widget stays hidden', async () => {
    const mock = new MockTransport(sampleMockOptions('en'));
    vi.spyOn(mock, 'getConfig').mockRejectedValue(new Error('offline'));
    const controller = new WidgetController(mock, 'en');

    await controller.init();

    expect(controller.state.status).toBe('failed');
  });

  it('restarts the session when the host page identifies the visitor during start-up (M4-02)', async () => {
    const mock = new MockTransport(sampleMockOptions('en'));
    const startSession = vi.spyOn(mock, 'startSession');
    const controller = new WidgetController(mock, 'en');
    const identity = { user_id: 'u1', ts: 1, signature: 'sig' };

    const starting = controller.init();
    await controller.identify(identity);
    await starting;

    expect(startSession.mock.calls).toEqual([[null], [identity]]);
  });
});

describe('sending (DOMAIN-RULES §7)', () => {
  it('shows a message as sending, then replaces it with the stored one holding a seq', async () => {
    const { controller, mock } = await setup();

    controller.send('  Hi, my refund has not arrived.  ');
    expect(controller.state.thread.pending).toMatchObject([
      { body: 'Hi, my refund has not arrived.', status: 'sending' },
    ]);

    await settle();
    await vi.waitFor(() => expect(controller.state.thread.pending).toEqual([]));
    expect(controller.state.thread.confirmed.map((message) => message.seq)).toEqual([1]);
    expect(visitorMessages(mock)).toHaveLength(1);
  });

  it('ignores a blank message', async () => {
    const { controller } = await setup();

    controller.send('   ');

    expect(controller.state.thread.pending).toEqual([]);
  });

  it('starts one conversation for messages queued before it exists', async () => {
    const { controller, mock } = await setup();

    controller.send('one');
    controller.send('two');
    await vi.waitFor(() => expect(controller.state.thread.confirmed).toHaveLength(2));

    expect(mock.calls.filter((call) => call.method === 'startConversation')).toHaveLength(1);
  });

  it('opens the next conversation with the article "Still need help?" came from, once (M5-08)', async () => {
    const { controller, mock } = await setup();
    controller.setArticleContext('0192c3f0-1a2b-7c3d-8e4f-0000000000a1');

    controller.send('I still need help');
    await vi.waitFor(() => expect(controller.state.thread.confirmed).toHaveLength(1));

    expect(mock.calls.find((call) => call.method === 'startConversation')?.args).toEqual([
      { article_id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1' },
    ]);
    expect(controller.articleId).toBeNull();
  });

  it('carries the article on a pre-chat start too, and nothing without one', async () => {
    const { controller, mock } = await setup();

    await controller.startConversation({ email: 'omar@example.com' });
    controller.setArticleContext('0192c3f0-1a2b-7c3d-8e4f-0000000000a1');
    await controller.startConversation({ email: 'omar@example.com' });

    const starts = mock.calls.filter((call) => call.method === 'startConversation');
    expect(starts.map((call) => call.args[0])).toEqual([
      { email: 'omar@example.com' },
      { email: 'omar@example.com', article_id: '0192c3f0-1a2b-7c3d-8e4f-0000000000a1' },
    ]);
  });

  it('retries with the same client_id, so a lost answer never makes a second message', async () => {
    vi.useFakeTimers();
    const { controller, mock } = await setup();
    mock.failNextSends(2);

    controller.send('once');
    await vi.runAllTimersAsync();

    const sends = mock.calls.filter((call) => call.method === 'sendMessage');
    const ids = new Set(sends.map((call) => (call.args[1] as { client_id: string }).client_id));
    expect(sends).toHaveLength(3);
    expect(ids.size).toBe(1);
    expect(visitorMessages(mock)).toHaveLength(1);
  });

  it('marks the message not sent after 10 seconds of failures, and Retry sends it', async () => {
    vi.useFakeTimers();
    const { controller, mock } = await setup();
    await controller.startConversation({});
    mock.failNextSends(100);

    controller.send('stuck');
    await vi.runAllTimersAsync();
    expect(controller.state.thread.pending).toMatchObject([{ status: 'failed' }]);

    mock.failNextSends(0);
    const [entry] = controller.state.thread.pending;
    controller.retry(entry?.client_id ?? '');
    await vi.runAllTimersAsync();

    expect(controller.state.thread.pending).toEqual([]);
    expect(visitorMessages(mock).map((message) => message.body)).toEqual(['stuck']);
  });

  it('holds a message written while reconnecting and sends it when the connection is back', async () => {
    const { controller, mock } = await setup();
    await controller.startConversation({});
    mock.dropConnection();

    controller.send('while offline');
    await flush();
    expect(mock.calls.some((call) => call.method === 'sendMessage')).toBe(false);
    expect(controller.state.thread.pending).toMatchObject([{ status: 'sending' }]);

    mock.restoreConnection();
    await vi.waitFor(() => expect(controller.state.thread.pending).toEqual([]));
    expect(visitorMessages(mock)).toHaveLength(1);
  });

  it('says who the visitor is talking to after their first message, or that it replies after opening', async () => {
    const open = await setup();
    await open.controller.startConversation({ email: 'omar@example.com' });
    open.controller.send('hi');
    expect(open.controller.state.firstMessageNotice).toBe('talking');

    const closed = await setup({ availability: 'closed' });
    await closed.controller.startConversation({ email: 'omar@example.com' });
    closed.controller.send('hi');
    expect(closed.controller.state.firstMessageNotice).toBe('closed');
  });
});

describe('receiving', () => {
  it('adds agent messages, counts them unread while the window is closed, and clears on open', async () => {
    const { controller, mock } = await setup();
    await controller.startConversation({});

    mock.agentReply(LINA, 'Hello');
    mock.agentReply(LINA, 'Are you there?');
    expect(controller.state.unread).toBe(2);

    controller.setOpen(true);
    expect(controller.state.unread).toBe(0);
    expect(mock.calls).toContainEqual({ method: 'markRead', args: ['conversation-1', 2] });
  });

  it('catches up from its cursor when a live event arrives with a gap', async () => {
    const { controller, mock } = await setup();
    await controller.startConversation({});
    mock.storeSilently(LINA, 'lost on the socket');

    mock.agentReply(LINA, 'arrives with seq 2');

    await vi.waitFor(() =>
      expect(controller.state.thread.confirmed.map((message) => message.seq)).toEqual([1, 2]),
    );
    expect(mock.calls).toContainEqual({ method: 'listMessages', args: ['conversation-1', 0] });
    expect(controller.state.thread.lastSeq).toBe(2);
  });

  it('catches up after a reconnect and announces how many messages arrived meanwhile', async () => {
    const { controller, mock } = await setup();
    await controller.startConversation({});
    controller.send('before the drop');
    await vi.waitFor(() => expect(controller.state.thread.lastSeq).toBe(1));

    mock.dropConnection();
    expect(controller.state.connection).toBe('reconnecting');
    mock.storeSilently(LINA, 'one');
    mock.storeSilently(LINA, 'two');
    mock.restoreConnection();

    await vi.waitFor(() =>
      expect(controller.state.reconnected).toEqual({ newCount: 2, firstNewSeq: 2 }),
    );
    expect(controller.state.thread.lastSeq).toBe(3);

    controller.clearReconnected();
    expect(controller.state.reconnected).toBeNull();
  });

  it('applies read receipts, typing, presence, queue position and assignment', async () => {
    const { controller, mock } = await setup();
    await controller.startConversation({});
    controller.send('hi');
    await vi.waitFor(() => expect(controller.state.thread.lastSeq).toBe(1));

    mock.emit({ type: 'receipt', kind: 'read', seq: 1 });
    mock.emit({ type: 'receipt', kind: 'delivered', seq: 5 });
    mock.emit({ type: 'queue', position: 2, eta_seconds: 180 });
    mock.emit({ type: 'typing', typing: true, agent: LINA });
    mock.setAvailability(sampleAvailability('open_offline'));

    expect(controller.state.thread.readSeq).toBe(1);
    expect(controller.state.queue).toEqual({ position: 2, eta_seconds: 180 });
    expect(controller.state.typing).toEqual(LINA);
    expect(controller.state.availability?.state).toBe('open_offline');

    mock.assign(LINA, 'Billing');
    expect(controller.state.queue).toBeNull();
    expect(controller.state.conversation?.agent).toEqual(LINA);

    mock.agentReply(LINA, 'Hi');
    expect(controller.state.typing).toBeNull();

    mock.end();
    expect(controller.state.conversation?.status).toBe('ended');
  });
});

describe('attachments and voice (M4-07)', () => {
  it('refuses a file over the policy without uploading it', async () => {
    const { controller, mock } = await setup();
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'huge.pdf', {
      type: 'application/pdf',
    });

    controller.sendFiles([big]);

    expect(controller.state.attachmentProblem?.key).toBe('attachment.tooLarge.file');
    expect(mock.calls.some((call) => call.method === 'uploadAttachment')).toBe(false);
    controller.dismissAttachmentProblem();
    expect(controller.state.attachmentProblem).toBeNull();
  });

  it('uploads accepted files and sends them as one message', async () => {
    const { controller, mock } = await setup();
    const photo = new File([new Uint8Array(10)], 'bank-statement.webp', { type: 'image/webp' });

    controller.sendFiles([photo]);
    expect(controller.state.thread.pending[0]?.attachments).toMatchObject([
      { name: 'bank-statement.webp', kind: 'image' },
    ]);

    await vi.waitFor(() => expect(controller.state.thread.confirmed).toHaveLength(1));
    expect(controller.state.thread.confirmed[0]?.attachments).toMatchObject([
      { id: 'upload-1', kind: 'image' },
    ]);
    expect(mock.calls.find((call) => call.method === 'uploadAttachment')?.args).toEqual([
      'bank-statement.webp',
      'image',
    ]);
  });

  it('sends a recording as a voice attachment when voice is allowed', async () => {
    const { controller } = await setup();

    controller.sendVoice(new Blob([new Uint8Array(10)], { type: 'audio/webm' }), 'voice.webm');

    await vi.waitFor(() =>
      expect(controller.state.thread.confirmed[0]?.attachments[0]?.kind).toBe('voice'),
    );
  });
});

describe('typing, transcript and a new conversation', () => {
  it('tells the agent side once when the visitor starts typing and once when they stop', async () => {
    vi.useFakeTimers();
    const { controller, mock } = await setup();
    await controller.startConversation({});

    controller.visitorTyping();
    controller.visitorTyping();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(
      mock.calls.filter((call) => call.method === 'sendTyping').map((call) => call.args[1]),
    ).toEqual([true, false]);
  });

  it('requests the transcript for this conversation only, then starts afresh', async () => {
    const { controller, mock } = await setup();
    await controller.startConversation({ email: 'omar@example.com' });
    controller.send('hi');
    await vi.waitFor(() => expect(controller.state.thread.lastSeq).toBe(1));

    await controller.requestTranscript('omar@example.com');
    expect(mock.calls).toContainEqual({
      method: 'requestTranscript',
      args: ['conversation-1', 'omar@example.com'],
    });

    await controller.newConversation();
    expect(controller.state.conversation).toBeNull();
    expect(controller.state.thread.confirmed).toEqual([]);
    expect(controller.state.firstMessageNotice).toBeNull();
  });
});
