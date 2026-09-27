import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWidget } from '../test/render.js';
import { TransportError } from '../transport/types.js';

afterEach(() => {
  cleanup();
});

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open support chat' }));
const type = (label: string, value: string) =>
  fireEvent.input(
    screen.getByRole(label === 'Search help articles' ? 'searchbox' : 'textbox', { name: label }),
    {
      target: { value },
    },
  );

describe('contact form mode (WidgetModesEN column 3)', () => {
  it('creates a ticket and shows its reference in place of the form', async () => {
    const { mock } = await renderWidget({ mode: 'form', availability: 'open_offline' });
    open();

    expect(screen.getByRole('heading', { name: 'Contact Helpdock' })).toBeTruthy();
    expect(
      screen.getByText('No one is online right now. Leave a message and we will reply by email.'),
    ).toBeTruthy();
    type('Name', 'Omar Khalil');
    type('Email', 'omar.k@example.com');
    type('Order number (optional)', '8841');
    type('Message', 'I need to change the delivery address.');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('heading', { name: 'Message sent' })).toBeTruthy();
    expect(
      screen.getByText('Your reference is HD-1043. We will reply to omar.k@example.com.'),
    ).toBeTruthy();
    expect(mock.calls.find((call) => call.method === 'submitContactForm')?.args[0]).toEqual({
      name: 'Omar Khalil',
      email: 'omar.k@example.com',
      message: 'I need to change the delivery address.',
      fields: { order: '8841' },
      attachment_ids: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send another message' }));
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
  });

  it('keeps the form and says why when the ticket cannot be created', async () => {
    const { mock } = await renderWidget({ mode: 'form' });
    vi.spyOn(mock, 'submitContactForm').mockRejectedValue(new TransportError('network'));
    open();

    type('Name', 'Omar');
    type('Email', 'omar@example.com');
    type('Message', 'Hello');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'We could not send your message. Try again.',
    );
  });

  it('asks for the required fields before sending', async () => {
    const { mock } = await renderWidget({ mode: 'form' });
    open();

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
      'Fill in this field.',
      'Enter an email like name@example.com.',
      'Fill in this field.',
    ]);
    expect(mock.calls.some((call) => call.method === 'submitContactForm')).toBe(false);
  });
});

describe('help center mode (WidgetModesEN columns 4 and 5)', () => {
  it('lists popular articles, searches them, and says when nothing matches', async () => {
    await renderWidget({ mode: 'helpcenter' });
    open();

    const popular = await screen.findByRole('list', { name: 'Popular articles' });
    expect(within(popular).getAllByRole('link')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Helpdock help' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();

    type('Search help articles', 'refund');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(
      within(results)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([expect.stringContaining('Refund timelines')]);
    expect(screen.getByRole('status').textContent).toBe('1 article for “refund”');

    type('Search help articles', 'zzz');
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('No articles match. Try other words.'),
    );
  });

  it('opens an article inside the window, sanitised, and goes back to the list', async () => {
    await renderWidget({ mode: 'helpcenter' });
    open();

    fireEvent.click(await screen.findByRole('link', { name: /Refund timelines/ }));

    expect(await screen.findByText(/We issue your refund/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Refund timelines' })).toBeTruthy();
    expect(screen.getByText('Updated 12 Sept 2026 · 2 min read')).toBeTruthy();
    expect(document.querySelector('.hd-article-body script')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open in help center' }).getAttribute('href')).toBe(
      'https://help.example.com/en/articles/refund-timelines',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Back to articles' }));
    expect(await screen.findByRole('list', { name: 'Popular articles' })).toBeTruthy();
  });

  it('says so when an article cannot load', async () => {
    const { mock } = await renderWidget({ mode: 'helpcenter' });
    vi.spyOn(mock, 'getArticle').mockRejectedValue(new TransportError('network'));
    open();

    fireEvent.click(await screen.findByRole('link', { name: /Refund timelines/ }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This article could not be loaded. Try again.',
    );
  });
});

describe('chat + suggested articles mode (WidgetModesEN column 2)', () => {
  it('shows popular articles once the visitor types, and opens one in the window', async () => {
    await renderWidget({ mode: 'chat_articles' });
    open();

    expect(screen.queryByRole('navigation', { name: 'Articles that might help' })).toBeNull();
    type('Message', 'refund');
    const strip = screen.getByRole('navigation', { name: 'Articles that might help' });
    expect(within(strip).getAllByRole('link')).toHaveLength(3);

    fireEvent.click(within(strip).getByRole('link', { name: /Refund timelines/ }));
    expect(await screen.findByText(/We issue your refund/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(screen.getByRole('log')).toBeTruthy();
  });
});
