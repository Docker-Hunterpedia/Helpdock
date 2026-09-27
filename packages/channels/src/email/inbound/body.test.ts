import { describe, expect, it } from 'vitest';
import {
  extractImages,
  processEmailBody,
  splitHtmlQuote,
  splitTextQuote,
  textToHtml,
} from './body.js';

describe('splitHtmlQuote', () => {
  it.each([
    ['Gmail', '<div>Thanks</div><div class="gmail_quote"><div>old</div></div>'],
    ['Apple Mail', '<div>Thanks</div><blockquote type="cite">old</blockquote>'],
    ['Outlook', '<div>Thanks</div><div id="divRplyFwdMsg">From: us old</div>'],
    ['Outlook append', '<div>Thanks</div><div id=appendonsend></div><hr>old'],
    ['Yahoo', '<div>Thanks</div><div class="yahoo_quoted">old</div>'],
    ['Original Message', '<p>Thanks</p><p>-----Original Message-----</p>old'],
  ])('cuts a %s quote', (_client, html) => {
    const { reply, quoted } = splitHtmlQuote(html);

    expect(reply).toContain('Thanks');
    expect(reply).not.toContain('old');
    expect(quoted).toContain('old');
  });

  it('removes the attribution line above the quote, in English and Arabic', () => {
    expect(
      splitHtmlQuote(
        '<div>Thanks</div><div>On Tue, 15 Sep 2026, Lina wrote:<br></div><blockquote type="cite">x</blockquote>',
      ).reply,
    ).toBe('<div>Thanks</div>');
    expect(
      splitHtmlQuote(
        '<p>شكرا</p><div>في ١٥ سبتمبر، كتب لينا:</div><blockquote type="cite">x</blockquote>',
      ).reply,
    ).toBe('<p>شكرا</p>');
  });

  it('keeps a body that starts with the quote whole: nothing would be left', () => {
    const html = '<blockquote type="cite">forwarded</blockquote><p>fyi</p>';
    expect(splitHtmlQuote(html)).toEqual({ reply: html, quoted: null });
  });

  it('keeps a body with no quote whole', () => {
    expect(splitHtmlQuote('<p>Hello</p>')).toEqual({ reply: '<p>Hello</p>', quoted: null });
  });
});

describe('splitTextQuote', () => {
  it('cuts at the attribution line', () => {
    expect(splitTextQuote('Thanks!\n\nOn Tue, Lina wrote:\n> old')).toEqual({
      reply: 'Thanks!',
      quoted: 'On Tue, Lina wrote:\n> old',
    });
  });

  it('cuts at a > block and at an Outlook rule', () => {
    expect(splitTextQuote('Yes\n> old').reply).toBe('Yes');
    expect(splitTextQuote('Yes\n________________\nFrom: us').reply).toBe('Yes');
  });

  it('keeps text that is all quote', () => {
    expect(splitTextQuote('> only quote').quoted).toBeNull();
  });
});

describe('textToHtml', () => {
  it('escapes, keeps line breaks and makes paragraphs of blank-line blocks', () => {
    expect(textToHtml('a <b> & "c"\nline two\r\n\r\nsecond')).toBe(
      '<p>a &lt;b&gt; &amp; &quot;c&quot;<br />line two</p><p>second</p>',
    );
  });
});

describe('extractImages', () => {
  it('removes cid and remote images, records each, and drops a src-less one', () => {
    const { html, remote, contentIds } = extractImages(
      '<p>a<img src="cid:shot%40x" />b<img src="https://mail.acme.de/p.gif?a=1&amp;b=2" alt="logo" /><img alt="none" /><img src="cid:shot@x" /></p>',
    );

    expect(html).toBe('<p>ab</p>');
    expect(contentIds).toEqual(['shot@x']);
    expect(remote).toEqual([{ url: 'https://mail.acme.de/p.gif?a=1&b=2', alt: 'logo' }]);
  });
});

describe('processEmailBody (M2-04, M2-07)', () => {
  it('strips scripts and forms, cuts the quote and takes the images out', () => {
    const body = processEmailBody({
      html:
        '<p>Hello<script>alert(1)</script></p><form><input value="pw"></form>' +
        '<img src="https://tracker.example/pixel.gif"><img src="cid:logo@x">' +
        '<div class="gmail_quote"><p>earlier</p><img src="https://old.example/i.png"></div>',
      text: null,
    });

    expect(body.html).toBe('<p>Hello</p>');
    expect(body.text).toBe('Hello');
    expect(body.html).not.toMatch(/script|form|input|img/);
    expect(body.remoteImages).toEqual([{ url: 'https://tracker.example/pixel.gif', alt: '' }]);
    expect(body.inlineContentIds).toEqual(['logo@x']);
    expect(body.quotedHtml).toContain('earlier');
    expect(body.quotedHtml).not.toContain('<img');
  });

  it('builds the body from text when there is no HTML', () => {
    const body = processEmailBody({ html: null, text: 'Hi <there>\n\nOn Mon, X wrote:\n> old' });

    expect(body.html).toBe('<p>Hi &lt;there&gt;</p>');
    expect(body.quotedHtml).toContain('old');
    expect(body.remoteImages).toEqual([]);
  });

  it('drops a quote that is empty once sanitised', () => {
    const body = processEmailBody({
      html: '<p>Hi</p><div class="gmail_quote"><script>x</script></div>',
      text: null,
    });

    expect(body.quotedHtml).toBeNull();
  });

  it('treats a missing body as empty', () => {
    expect(processEmailBody({ html: '  ', text: null }).html).toBe('');
  });
});
