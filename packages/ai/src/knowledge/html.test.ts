import { describe, expect, it } from 'vitest';
import { htmlToText } from './html.js';

describe('htmlToText', () => {
  it('keeps the content as headings and paragraphs and drops the page furniture', () => {
    const page = htmlToText(
      `<html><head><title>Refunds · Docs</title><style>p{}</style></head><body>
        <nav><a href="/home">Home</a></nav>
        <main>
          <h1>Refunds</h1>
          <p>Refunds take <b>five</b> days.</p>
          <ul><li>Card</li><li>Bank<br>transfer</li></ul>
          <table><tr><td>Plan</td><td>Days</td></tr></table>
          <script>alert(1)</script>
        </main>
        <footer>© Helpdock</footer>
      </body></html>`,
    );

    expect(page.title).toBe('Refunds · Docs');
    expect(page.text).toBe(
      '# Refunds\n\nRefunds take five days.\n\nCard\n\nBank transfer\n\nPlan Days',
    );
  });

  it('collects http links resolved against the page, without fragments', () => {
    const page = htmlToText(
      `<body><a href="/docs/a#top">a</a><a href="https://other.test/b">b</a>
        <a href="mailto:x@y.test">m</a><a href="javascript:void(0)">j</a><a href="http://[bad">x</a></body>`,
      'https://docs.example.com/start',
    );

    expect(page.links).toEqual(['https://docs.example.com/docs/a', 'https://other.test/b']);
  });

  it('falls back to the first heading for a page without a title', () => {
    expect(htmlToText('<body><h2>Shipping</h2><p>Two days.</p></body>').title).toBe('Shipping');
  });
});
