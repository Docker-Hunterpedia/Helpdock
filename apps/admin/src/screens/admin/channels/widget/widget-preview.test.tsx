import {
  WIDGET_SETTINGS_DEFAULTS,
  type WidgetAppearance,
  type WidgetConversationSettings,
} from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../../../test/render.tsx';
import { WidgetPreview } from './widget-preview.tsx';

/**
 * The live preview draws the Mode and the colour scheme the form says
 * (`Admin/UX-Fixes-2026-11`, "Widget live preview by mode"), in either language.
 */

const draw = (
  appearance: Partial<WidgetAppearance> = {},
  conversation: Partial<WidgetConversationSettings> = {},
) =>
  renderApp(
    <WidgetPreview
      appearance={{ ...WIDGET_SETTINGS_DEFAULTS.appearance, ...appearance }}
      conversation={{ ...WIDGET_SETTINGS_DEFAULTS.conversation, ...conversation }}
      brandName="Helpdock"
      customLabels={new Map()}
    />,
  );

const picture = (): HTMLElement => screen.getByRole('img', { name: 'Widget preview' });

describe('the widget preview by mode', () => {
  it('draws Chat as the greeting and a composer, with no articles', () => {
    draw({ mode: 'chat' });

    expect(within(picture()).getByText('Hi, how can we help today?')).toBeInTheDocument();
    expect(within(picture()).getByText('Write a message')).toBeInTheDocument();
    expect(within(picture()).queryByText('Suggested articles')).toBeNull();
  });

  it('draws Chat and suggested articles with the articles above the composer', () => {
    draw({ mode: 'chat_articles' });

    expect(within(picture()).getByText('Suggested articles')).toBeInTheDocument();
    expect(within(picture()).getByText('Reset your password')).toBeInTheDocument();
    expect(within(picture()).getByText('Write a message')).toBeInTheDocument();
  });

  it('draws Help center as a search, articles and Contact us, without the greeting', () => {
    draw({ mode: 'helpcenter' });

    expect(within(picture()).getByText('Search articles')).toBeInTheDocument();
    expect(within(picture()).getByText('Track an order')).toBeInTheDocument();
    expect(within(picture()).getByText('Contact us')).toBeInTheDocument();
    expect(within(picture()).queryByText('Hi, how can we help today?')).toBeNull();
    expect(within(picture()).queryByText('Write a message')).toBeNull();
  });

  it('draws the Contact form with a message box and Send', () => {
    draw({ mode: 'form' });

    expect(within(picture()).getByText('Message')).toBeInTheDocument();
    expect(within(picture()).getByText('Send')).toBeInTheDocument();
    expect(within(picture()).queryByText('Write a message')).toBeNull();
  });

  it('does not claim a pre-chat form that is off, and says so when it is on', () => {
    const { unmount } = draw({ mode: 'chat' }, { prechatEnabled: false });
    expect(screen.getByText(/The pre-chat form is off\./)).toBeInTheDocument();
    unmount();

    draw({ mode: 'chat' }, { prechatEnabled: true });
    expect(screen.getByText(/The pre-chat form is on\./)).toBeInTheDocument();
    expect(within(picture()).getByText('Before we start')).toBeInTheDocument();
  });

  it('has nothing to say about the pre-chat form in modes that never show it', () => {
    draw({ mode: 'helpcenter' });

    expect(screen.queryByText(/pre-chat form/)).toBeNull();
  });
});

describe('the colour scheme', () => {
  it('keeps the theme toggle for Auto', () => {
    draw({ colorScheme: 'auto' });

    expect(screen.getByRole('group', { name: 'Preview theme' })).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('hides the toggle when the form says %s', (colorScheme) => {
    draw({ colorScheme });

    expect(screen.queryByRole('group', { name: 'Preview theme' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Preview language' })).toBeInTheDocument();
  });

  it('draws the dark surface when the form says Dark', () => {
    draw({ colorScheme: 'dark' });

    const dark = getComputedStyle(picture()).backgroundColor;
    expect(dark).not.toBe('');
    const { unmount } = draw({ colorScheme: 'light' });
    const lights = screen.getAllByRole('img', { name: 'Widget preview' });
    expect(getComputedStyle(lights.at(-1) as Element).backgroundColor).not.toBe(dark);
    unmount();
  });
});
