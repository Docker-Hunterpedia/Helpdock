import { describe, expect, it } from 'vitest';
import {
  type CustomerEmailLayout,
  linkify,
  paragraphsToHtml,
  renderCustomerEmail,
} from './customer-layout.js';

const layout: CustomerEmailLayout = {
  locale: 'en',
  dir: 'ltr',
  brandName: 'Helpdock',
  replyMarker: '##- Please type your reply above this line -##',
  bodyHtml: '<p>Hi Mona,</p><p>Your refund was issued.</p>',
  bodyText: 'Hi Mona,\n\nYour refund was issued.',
  signature: 'Lina Haddad\nBilling team · Helpdock',
  note: null,
  reference: {
    label: 'Request',
    token: '[HD-1042]',
    subject: 'Refund not received',
    hint: 'Reply to this email to add to your request.',
  },
  footer: 'You are receiving this because you contacted Helpdock support.',
};

describe('renderCustomerEmail', () => {
  it('draws the reply marker, the body, the signature and the reference', () => {
    const { html, text } = renderCustomerEmail(layout);

    expect(html).toContain('##- Please type your reply above this line -##');
    expect(html).toContain('<p>Your refund was issued.</p>');
    expect(html).toContain('Lina Haddad');
    expect(html).toContain('<bdi style="font-family:');
    expect(html).toContain('[HD-1042]');
    expect(text).toBe(
      [
        '##- Please type your reply above this line -##',
        '',
        'Hi Mona,\n\nYour refund was issued.',
        '',
        '-- ',
        'Lina Haddad',
        'Billing team · Helpdock',
        '',
        'Request [HD-1042] · Refund not received',
        'Reply to this email to add to your request.',
        '',
        'Helpdock',
        'You are receiving this because you contacted Helpdock support.',
      ].join('\n'),
    );
  });

  it('leaves the marker and signature out of an auto-reply and adds its note', () => {
    const { html, text } = renderCustomerEmail({
      ...layout,
      replyMarker: null,
      signature: null,
      note: 'This is an automatic reply.',
    });

    expect(html).not.toContain('##-');
    expect(text.startsWith('Hi Mona,')).toBe(true);
    expect(text).toContain('This is an automatic reply.');
    expect(text).not.toContain('-- ');
  });

  it('mirrors an Arabic message and sets its language', () => {
    const { html } = renderCustomerEmail({ ...layout, locale: 'ar', dir: 'rtl' });

    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain("'IBM Plex Sans Arabic'");
  });

  it('escapes the brand name and ignores an accent that is not a colour', () => {
    const { html } = renderCustomerEmail({
      ...layout,
      brandName: '<script>x</script>',
      accent: 'red;background:url(x)',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('background:#0F766E');
  });

  it('links the help center when the brand has one', () => {
    const { html, text } = renderCustomerEmail({
      ...layout,
      helpCenterUrl: 'https://help.helpdock.io',
    });

    expect(html).toContain('href="https://help.helpdock.io"');
    expect(text).toContain('Helpdock · https://help.helpdock.io');
  });
});

describe('linkify', () => {
  it('escapes the text and links a URL in it', () => {
    expect(linkify('See <b> https://example.com/a?b=1&c=2')).toBe(
      'See &lt;b&gt; <a href="https://example.com/a?b=1&amp;c=2" style="color:#0F766E">https://example.com/a?b=1&amp;c=2</a>',
    );
  });
});

describe('paragraphsToHtml', () => {
  it('turns blank lines into paragraphs and newlines into breaks', () => {
    expect(paragraphsToHtml('Hi Mona,\n\nLine one\nLine two\n\n\n')).toBe(
      '<p style="margin:0 0 16px 0">Hi Mona,</p><p style="margin:0 0 16px 0">Line one<br>Line two</p>',
    );
  });
});
