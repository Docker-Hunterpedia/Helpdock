import { renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../auth/session.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { KeyboardProvider, useKeyboard, useShortcutHandlers } from './keyboard-provider.tsx';

/**
 * What the palette asks of the keyboard (M14-05): whether a screen has
 * attached a handler for a shortcut the person may use, and to run it as its
 * key would.
 */

async function inProvider(role: 'admin' | 'viewer', handler: () => void) {
  const apis = await signedInMockApis();
  const session = await apis.auth.me();
  if (session === null) throw new Error('signed-in fixture needs a session');
  const as = { ...session, user: { ...session.user, role } };

  function Attached(): null {
    useShortcutHandlers({ 'ticket.reply': handler });
    return null;
  }
  let keyboard: ReturnType<typeof useKeyboard> | undefined;
  function Probe(): null {
    const value = useKeyboard();
    useEffect(() => {
      keyboard = value;
    });
    return null;
  }
  renderApp(
    <SessionProvider session={as}>
      <KeyboardProvider>
        <Attached />
        <Probe />
      </KeyboardProvider>
    </SessionProvider>,
    { authApi: apis.auth },
  );
  await vi.waitFor(() => {
    expect(keyboard).toBeDefined();
  });
  return keyboard as ReturnType<typeof useKeyboard>;
}

describe('useKeyboard().isAvailable and run', () => {
  it('runs the handler a screen attached, for a person who may use it', async () => {
    const handler = vi.fn();
    const keyboard = await inProvider('admin', handler);

    expect(keyboard.isAvailable('ticket.reply')).toBe(true);
    expect(keyboard.run('ticket.reply')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('has nothing to run for a shortcut no screen attached', async () => {
    const keyboard = await inProvider('admin', vi.fn());

    expect(keyboard.isAvailable('ticket.note')).toBe(false);
    expect(keyboard.run('ticket.note')).toBe(false);
  });

  it('refuses a shortcut the person may not use, though a screen attached it', async () => {
    const handler = vi.fn();
    const keyboard = await inProvider('viewer', handler);

    expect(keyboard.isAvailable('ticket.reply')).toBe(false);
    expect(keyboard.run('ticket.reply')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers nothing outside a provider', () => {
    const { result } = renderHook(() => useKeyboard());

    expect(result.current.isAvailable('ticket.reply')).toBe(false);
    expect(result.current.run('ticket.reply')).toBe(false);
  });
});
