import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { MessageBubble } from './message-bubble.tsx';

describe('a message bubble', () => {
  // Every channel, not only Meta's (M10-08): an email in English is as mixed
  // into an Arabic admin as a WhatsApp message is.
  it('lets the author and the body take their own direction (DESIGN §7)', () => {
    renderApp(
      <MessageBubble
        kind="contact"
        author="Mona Khalil"
        meta="10:02"
        bodyHtml="<p>Is the batch from the 2nd?</p>"
      />,
    );

    expect(screen.getByText('Mona Khalil')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Is the batch from the 2nd?').parentElement).toHaveAttribute(
      'dir',
      'auto',
    );
  });
});
