import { expect, it } from 'vitest';
import { importedMessageBody } from './message-body.js';

it('preserves literal markup in plain history without turning it into active HTML', () => {
  const body = importedMessageBody({
    bodyText: '<script>alert(1)</script> & customer\nSecond line',
  });
  expect(body.html).not.toContain('<script>');
  expect(body.html).toContain('&lt;script&gt;');
  expect(body.text).toContain('<script>alert(1)</script> & customer');
  expect(body.text).toContain('Second line');
});

it('uses the supplied HTML body and removes executable content and tracking images', () => {
  const body = importedMessageBody({
    bodyHtml:
      '<p>Historical answer</p><script>alert(1)</script><img src="https://tracker.invalid/pixel">',
    bodyText: 'Untrusted fallback',
  });
  expect(body.html).not.toMatch(/script|tracker\.invalid/);
  expect(body.text).toBe('Historical answer');
});
