import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../auth/session.tsx';
import { renderApp } from '../test/render.tsx';
import { signedInMockApis } from '../test/signed-in.js';
import { KeyboardProvider, useShortcutHandlers } from './keyboard-provider.tsx';
import { SHORTCUT_LIST, type ShortcutId } from './registry.js';

async function renderKeyboard() {
  const apis = await signedInMockApis();
  const session = await apis.auth.me();
  if (session === null) throw new Error('signed-in fixture needs a session');
  const shortcut = vi.fn();
  function Handlers() {
    useShortcutHandlers(
      Object.fromEntries(SHORTCUT_LIST.map(({ id }) => [id, shortcut])) as Record<
        ShortcutId,
        () => void
      >,
    );
    return <textarea aria-label="Reply" data-shortcut-scope="composer" />;
  }
  const rendered = renderApp(
    <SessionProvider session={session}>
      <KeyboardProvider>
        <Handlers />
      </KeyboardProvider>
    </SessionProvider>,
    { authApi: apis.auth },
  );
  return { ...rendered, shortcut };
}

const controls = [
  ['text input', '<input>'],
  ['textarea', '<textarea></textarea>'],
  ['select', '<select><option>First</option></select>'],
  ['number input', '<input type="number">'],
  ['DatePicker input', '<input type="date">'],
  ['range', '<input type="range">'],
  ['MUI Select', '<div role="combobox" tabindex="0"></div>'],
  ['Autocomplete', '<input role="combobox">'],
  ['ARIA spinbutton', '<div role="spinbutton" tabindex="0"></div>'],
  ['ARIA slider', '<div role="slider" tabindex="0"></div>'],
  ['ARIA textbox', '<div role="textbox" tabindex="0"></div>'],
  ['contenteditable child', '<div contenteditable="true"><span tabindex="0"></span></div>'],
  [
    'plaintext editor child',
    '<div contenteditable="plaintext-only"><span tabindex="0"></span></div>',
  ],
] as const;

const plainKeys = ['j', 'g', 'i', '?', '؟', 'Enter', 'Escape'];

describe('M14-01 keyboard ownership', () => {
  it.each(controls)(
    'leaves letters, ?, Enter and Escape to a %s, even after g',
    async (_name, html) => {
      const { container, shortcut } = await renderKeyboard();
      const host = document.createElement('div');
      host.innerHTML = html;
      container.append(host);
      const control = host.querySelector<HTMLElement>('span, input, textarea, select, [tabindex]');
      if (control === null) throw new Error('control fixture needs a focus target');
      const received = vi.fn();
      control.addEventListener('keydown', received);
      for (const key of plainKeys) {
        fireEvent.keyDown(document.body, { key: 'g' });
        control.focus();
        expect(fireEvent.keyDown(control, { key })).toBe(true);
      }
      expect(received.mock.calls.map(([event]) => (event as KeyboardEvent).key)).toEqual(plainKeys);
      expect(shortcut).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).toBeNull();
    },
  );

  it.each(['dialog', 'alertdialog', 'menu', 'listbox', 'native dialog'])(
    'leaves keys to an open %s even when focus is outside it',
    async (role) => {
      const { container, shortcut } = await renderKeyboard();
      const overlay = document.createElement(role === 'native dialog' ? 'dialog' : 'div');
      if (role === 'native dialog') overlay.setAttribute('open', '');
      else overlay.setAttribute('role', role);
      const button = document.createElement('button');
      overlay.append(button);
      container.append(overlay);
      for (const target of [button, document.body]) {
        for (const key of plainKeys) {
          expect(fireEvent.keyDown(target, { key })).toBe(true);
        }
        expect(fireEvent.keyDown(target, { key: '\\', ctrlKey: true })).toBe(true);
      }
      // A modal also owns modified Enter, even if the composer retains focus.
      expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true })).toBe(
        true,
      );
      expect(shortcut).not.toHaveBeenCalled();
    },
  );

  it('ignores hidden overlays and resumes shortcuts once a menu closes', async () => {
    const { container, shortcut } = await renderKeyboard();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    container.append(menu);
    expect(fireEvent.keyDown(document.body, { key: '?' })).toBe(true);
    menu.hidden = true;
    expect(fireEvent.keyDown(menu, { key: '?' })).toBe(false);
    expect(shortcut).toHaveBeenCalledOnce();
    shortcut.mockClear();
    expect(fireEvent.keyDown(document.body, { key: '?' })).toBe(false);
    expect(shortcut).toHaveBeenCalledOnce();
  });

  it('does not expose an idle sequence chip as a second toast status (PR #324)', async () => {
    const { container } = await renderKeyboard();
    const toast = document.createElement('div');
    toast.setAttribute('role', 'status');
    toast.textContent = 'Saved';
    container.append(toast);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    fireEvent.keyDown(document.body, { key: 'g' });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'q' });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('keeps an idle polite atomic live region mounted without a status role', async () => {
    const { container } = await renderKeyboard();
    const region = container.querySelector('[aria-live="polite"][aria-atomic="true"]');
    expect(region).not.toBeNull();
    expect(region).toBeEmptyDOMElement();
    expect(region).not.toHaveAttribute('role');
    fireEvent.keyDown(document.body, { key: 'g' });
    expect(region).toHaveTextContent('g');
    expect(region).not.toHaveAttribute('role');
  });

  it.each([
    '<button>Action</button>',
    '<input type="checkbox">',
    '<input type="radio">',
    '<input type="button">',
    '<input type="submit">',
    '<div role="switch" tabindex="0"></div>',
    '<div role="checkbox" tabindex="0"></div>',
    '<div role="radio" tabindex="0"></div>',
  ])('allows a letter shortcut on a focused non-typing control: %s', async (html) => {
    const { container, shortcut } = await renderKeyboard();
    const host = document.createElement('div');
    host.innerHTML = html;
    container.append(host);
    const control = host.firstElementChild as HTMLElement;
    control.focus();
    expect(control).toHaveFocus();
    expect(fireEvent.keyDown(control, { key: 'j' })).toBe(false);
    expect(shortcut).toHaveBeenCalledOnce();
  });

  it.each(['aria-hidden', 'fading'])(
    'releases keys when a dialog is %s during exit',
    async (exit) => {
      const { container, shortcut } = await renderKeyboard();
      const transition = document.createElement('div');
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      transition.append(dialog);
      container.append(transition);
      expect(fireEvent.keyDown(document.body, { key: 'j' })).toBe(true);
      if (exit === 'aria-hidden') transition.setAttribute('aria-hidden', 'true');
      else transition.style.opacity = '0';
      expect(fireEvent.keyDown(document.body, { key: 'j' })).toBe(false);
      expect(shortcut).toHaveBeenCalledOnce();
    },
  );

  it('never cancels an unmatched second sequence key', async () => {
    const { shortcut } = await renderKeyboard();
    fireEvent.keyDown(document.body, { key: 'g' });
    expect(fireEvent.keyDown(document.body, { key: 'q' })).toBe(true);
    expect(shortcut).not.toHaveBeenCalled();
  });

  it('keeps typed characters and newlines in the composer', async () => {
    const { user, shortcut } = await renderKeyboard();
    const reply = screen.getByRole('textbox');
    await user.type(reply, 'jgi?{Enter}');
    expect(reply).toHaveValue('jgi?\n');
    expect(shortcut).not.toHaveBeenCalled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(shortcut).toHaveBeenCalledOnce();
  });

  it('ignores composing keys and clears a pending sequence across an IME session', async () => {
    const { shortcut } = await renderKeyboard();
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.compositionStart(document.body);
    for (const key of plainKeys) {
      expect(fireEvent.keyDown(document.body, { key })).toBe(true);
    }
    fireEvent.compositionEnd(document.body);
    expect(fireEvent.keyDown(document.body, { key: 'i' })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: '?', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: '?', keyCode: 229 })).toBe(true);
    expect(shortcut).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(document.body, { key: '?' })).toBe(false);
    expect(shortcut).toHaveBeenCalledOnce();
  });
});
