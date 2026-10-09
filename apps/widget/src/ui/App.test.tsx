import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWidget, withIsolates } from '../test/render.js';
import { LINA, sampleConfig, samplePolicy } from '../transport/fixtures.js';
import { TransportError } from '../transport/types.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Open support chat' }));
  return screen.findByRole('region', { name: 'Support chat' });
};

const type = (label: string, value: string) =>
  fireEvent.input(screen.getByRole('textbox', { name: label }), { target: { value } });

describe('launcher and window (M4-11)', () => {
  it('opens a labelled window, focuses the message field, and closes on Escape back to the launcher', async () => {
    await renderWidget();
    const window = await open();

    expect(
      screen.getByRole('button', { name: 'Minimise support chat' }).getAttribute('aria-expanded'),
    ).toBe('true');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(window).getByRole('textbox', { name: 'Message' })),
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('region', { name: 'Support chat' })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Open support chat' }),
      ),
    );
  });

  it('is a modal dialog that keeps Tab inside it where it fills a phone screen (M9-04)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 480px)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await renderWidget();
    fireEvent.click(screen.getByRole('button', { name: 'Open support chat' }));
    const dialog = await screen.findByRole('dialog', { name: 'Support chat' });
    const minimise = within(dialog).getByRole('button', { name: 'Minimise chat' });
    const send = within(dialog).getByRole('button', { name: 'Send' });

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    send.focus();
    fireEvent.keyDown(send, { key: 'Tab' });
    expect(document.activeElement).toBe(minimise);
  });

  it('draws the thread as a focusable polite log with the brand greeting', async () => {
    await renderWidget();
    await open();
    const log = screen.getByRole('log', { name: 'Messages' });

    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.tabIndex).toBe(0);
    expect(within(log).getByText(/welcome to Helpdock support/)).toBeTruthy();
    expect(screen.getByText('Lina, Karim, and Sara are online')).toBeTruthy();
  });

  it('counts unread agent messages on the launcher while the window is closed', async () => {
    const { controller, mock } = await renderWidget();
    await act(() => controller.startConversation({}));

    act(() => {
      mock.agentReply(LINA, 'Hello?');
    });

    expect(
      screen.getByRole('button', { name: 'Open support chat, 1 unread message' }),
    ).toBeTruthy();
  });
});

describe('message states (WidgetStatesEN column 2)', () => {
  it('shows Sending then Sent, and Seen after the read receipt', async () => {
    const { mock } = await renderWidget();
    await open();

    type('Message', 'Hi, my refund has not arrived.');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByText('Sending…')).toBeTruthy();
    await screen.findByText(/· Sent$/);
    act(() => mock.emit({ type: 'receipt', kind: 'read', seq: 1 }));
    expect(screen.getByText(/· Seen$/)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLInputElement).value).toBe('');
  });

  it('shows Not sent in words with a Retry button described by the message', async () => {
    const { controller, mock } = await renderWidget();
    await open();
    await act(() => controller.startConversation({}));
    // A refusal is final, so the state flips at once instead of after the 10 s window.
    vi.spyOn(mock, 'sendMessage').mockRejectedValueOnce(new TransportError('policy_rejected'));

    type('Message', 'Can someone check?');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText('Not sent')).toBeTruthy();
    const describedBy = retry.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toEqual([
      'Can someone check?',
      'Not sent',
    ]);

    fireEvent.click(retry);
    await screen.findByText(/· Sent$/);
  });

  it('shows the reconnect banner, then Back online and the new-messages divider', async () => {
    const { controller, mock } = await renderWidget();
    await open();
    await act(() => controller.startConversation({}));

    act(() => mock.dropConnection());
    expect(screen.getByRole('status').textContent).toContain('Reconnecting…');

    mock.storeSilently(LINA, 'Thanks, I have asked the bank team.');
    act(() => mock.restoreConnection());

    await screen.findByText('Back online. You are up to date.');
    expect(screen.getByText('1 new message')).toBeTruthy();
    expect(screen.getByText('Thanks, I have asked the bank team.')).toBeTruthy();
  });
});

describe('header, queue and hours', () => {
  it('shows the queue position while waiting and the agent once assigned', async () => {
    const { controller, mock } = await renderWidget();
    await open();
    await act(() => controller.startConversation({}));

    act(() => mock.emit({ type: 'queue', position: 2, eta_seconds: 180 }));
    expect(screen.getByText('You are 2nd in line · about 3 min')).toBeTruthy();
    expect(screen.getByText('Finding someone for you')).toBeTruthy();

    act(() => mock.assign(LINA, 'Billing'));
    expect(screen.getByRole('heading', { name: 'Lina Haddad' })).toBeTruthy();
    expect(screen.getByText('Billing · Helpdock support')).toBeTruthy();
    expect(screen.getByText(/Lina Haddad joined/)).toBeTruthy();

    act(() => mock.emit({ type: 'typing', typing: true, agent: LINA }));
    expect(screen.getByText('Lina is typing…')).toBeTruthy();
  });

  it('shows the closed notice with the next opening (WidgetStatesEN column 4)', async () => {
    // The fixture opens on Sunday 27 September; an opening already past counts as open (M7-06).
    vi.useFakeTimers({ now: new Date('2026-09-25T17:40:00Z'), toFake: ['Date'] });
    await renderWidget({ availability: 'closed' });
    await open();

    expect(screen.getByText('We are closed right now')).toBeTruthy();
    expect(screen.getByText(/We open Sunday at 09:00 \(Gulf Standard Time\)/)).toBeTruthy();
    expect(screen.getByText('Back Sunday at 09:00')).toBeTruthy();
  });

  it('draws the Arabic strings in Arabic', async () => {
    await renderWidget({ locale: 'ar' });
    fireEvent.click(screen.getByRole('button', { name: 'فتح محادثة الدعم' }));

    expect(await screen.findByRole('region', { name: 'دردشة الدعم' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'دعم Helpdock' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'الرسالة' })).toBeTruthy();
  });
});

describe('pre-chat form (M4-08)', () => {
  it('announces an invalid email and a missing message, and starts the chat once valid', async () => {
    const { mock } = await renderWidget({ preChat: true });
    await open();

    type('Name', 'Omar Khalil');
    type('Email', 'omar.k@example');
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

    const email = screen.getByRole('textbox', { name: 'Email' });
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(email.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Enter an email like name@example.com.',
    );
    expect(screen.getAllByRole('alert')).toHaveLength(2);

    type('Email', 'omar.k@example.com');
    type('How can we help?', 'My refund for order 8841 has not arrived.');
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

    await screen.findByRole('log');
    expect(mock.calls.find((call) => call.method === 'startConversation')?.args[0]).toEqual({
      name: 'Omar Khalil',
      email: 'omar.k@example.com',
      fields: {},
    });
    await screen.findByText(
      withIsolates(
        'You are talking to Helpdock support. We will reply here and at omar.k@example.com.',
      ),
    );
  });

  it('says so when the chat cannot start', async () => {
    const { mock } = await renderWidget({ preChat: true });
    await open();
    vi.spyOn(mock, 'startConversation').mockRejectedValue(new TransportError('rate_limited'));

    type('Name', 'Omar');
    type('Email', 'omar@example.com');
    type('How can we help?', 'Help');
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many attempts. Wait a minute and try again.',
    );
  });
});

describe('CAPTCHA before the first message (ADR 0003)', () => {
  it('keeps Start chat disabled until the provider returns a token, then sends it along', async () => {
    let solve: ((token: string) => void) | null = null;
    vi.stubGlobal('turnstile', {
      render: (_element: HTMLElement, options: { callback: (token: string) => void }) => {
        solve = options.callback;
        return 'widget-1';
      },
    });
    const { mock } = await renderWidget({
      preChat: true,
      mock: {
        config: (locale) => ({
          ...sampleConfig(locale, { preChat: true }),
          captcha: { provider: 'turnstile', site_key: '1x00000000000000000000AA' },
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open support chat' }));

    const start = screen.getByRole('button', { name: 'Start chat' }) as HTMLButtonElement;
    expect(await screen.findByRole('group', { name: 'Security check' })).toBeTruthy();
    expect(start.disabled).toBe(true);

    await waitFor(() => expect(solve).not.toBeNull());
    act(() => solve?.('token-1'));
    expect(screen.getByText('Verified. You can continue.')).toBeTruthy();
    expect(start.disabled).toBe(false);

    type('Name', 'Omar');
    type('Email', 'omar@example.com');
    type('How can we help?', 'Help');
    fireEvent.click(start);

    await waitFor(() =>
      expect(mock.calls.find((call) => call.method === 'startConversation')?.args[0]).toMatchObject(
        { captcha_token: 'token-1' },
      ),
    );
  });
});

describe('ended conversation (WidgetStatesEN column 6)', () => {
  it('sends the transcript to the prefilled address and starts a new conversation', async () => {
    const { controller, mock } = await renderWidget();
    await open();
    await act(() => controller.startConversation({ email: 'omar@example.com' }));
    act(() => mock.end());

    expect(screen.getByRole('heading', { name: 'This conversation has ended' })).toBeTruthy();
    const field = screen.getByRole('textbox', {
      name: 'Email me the transcript',
    }) as HTMLInputElement;
    expect(field.value).toBe('omar@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('status')).textContent).toBe(
      'Transcript sent to omar@example.com.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start a new conversation' }));
    await screen.findByRole('textbox', { name: 'Message' });
  });

  it('hides the transcript form when the brand turns transcripts off', async () => {
    const { controller, mock } = await renderWidget({ transcript: false });
    await open();
    await act(() => controller.startConversation({}));
    act(() => mock.end());

    expect(screen.queryByRole('textbox', { name: 'Email me the transcript' })).toBeNull();
  });
});

describe('composer and content policy (M4-07)', () => {
  it('announces a file the policy refuses', async () => {
    await renderWidget();
    await open();
    const picker = document.querySelector('input[type=file]') as HTMLInputElement;
    const video = new File([new Uint8Array(1)], 'unboxing.mp4', { type: 'video/mp4' });
    Object.defineProperty(video, 'size', { value: 48 * 1024 * 1024 });

    fireEvent.change(picker, { target: { files: [video] } });

    expect(screen.getByRole('alert').textContent).toBe(
      'unboxing.mp4 is 48 MB. Videos can be up to 25 MB.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides the voice button when voice is off, and the paperclip when every file kind is off', async () => {
    vi.stubGlobal('MediaRecorder', class {});
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    const off = { enabled: false, max_bytes: 0, allowed_mime: [] };
    await renderWidget({
      policy: {
        ...samplePolicy,
        voice: { ...off, max_seconds: 0 },
        image: off,
        video: off,
        file: off,
      },
    });
    await open();

    expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Attach a file' })).toBeNull();
  });

  it('offers the voice button where MediaRecorder exists', async () => {
    vi.stubGlobal('MediaRecorder', class {});
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn() },
      configurable: true,
    });
    await renderWidget();
    await open();

    expect(screen.getByRole('button', { name: 'Record a voice message' })).toBeTruthy();
  });
});
