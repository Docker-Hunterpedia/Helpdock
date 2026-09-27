import { describe, expect, it } from 'vitest';
import {
  fieldId,
  type PageState,
  type PageView,
  renderWebFormPage,
  thankYouText,
} from './render.js';

const FORM: Extract<PageState, { kind: 'form' }> = {
  kind: 'form',
  fields: [
    { field: 'name', label: 'Name', type: 'name', required: false, options: [] },
    { field: 'email', label: 'Email', type: 'email', required: true, options: [] },
    {
      field: 'custom:plan',
      label: 'Plan',
      type: 'select',
      required: false,
      options: ['Pro', 'Team'],
    },
    {
      field: 'custom:areas',
      label: 'Areas',
      type: 'multi_select',
      required: false,
      options: ['Billing', 'Login'],
    },
    { field: 'custom:urgent', label: 'Urgent', type: 'checkbox', required: false, options: [] },
    { field: 'custom:order', label: 'Order', type: 'number', required: false, options: [] },
    { field: 'custom:since', label: 'Since', type: 'date', required: false, options: [] },
    { field: 'message', label: 'Message', type: 'long_text', required: true, options: [] },
  ],
  values: new Map(),
  fieldErrors: new Map(),
  formError: null,
  submissionId: 'sub-1',
  attachments: { max: 5, accept: ['image/png', 'application/pdf'], hint: 'Up to 5 files.' },
  captcha: null,
};

const view = (state: PageState, overrides: Partial<PageView> = {}): PageView => ({
  locale: 'en',
  brandName: 'Helpdock',
  path: '/contact/brand-1',
  helpCenterHref: null,
  nonce: 'n0nce',
  state,
  ...overrides,
});

describe('renderWebFormPage', () => {
  it('draws every field type with its label, and the hidden fields the post needs', () => {
    const html = renderWebFormPage(view(FORM));

    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain('<style nonce="n0nce">');
    expect(html).toContain('<label class="hd-label" for="wf-email">Email <span>required</span>');
    expect(html).toContain('<label class="hd-label" for="wf-name">Name <span>(optional)</span>');
    expect(html).toContain('<option value="Pro">Pro</option>');
    expect(html).toContain('<legend class="hd-label">Areas');
    expect(html).toContain('type="checkbox" id="wf-custom-urgent" name="custom:urgent"');
    expect(html).toContain('inputmode="decimal"');
    expect(html).toContain('type="date"');
    expect(html).toContain('<textarea class="hd-input" id="wf-message"');
    expect(html).toContain('accept="image/png,application/pdf"');
    expect(html).toContain('name="hd_submission" value="sub-1"');
    expect(html).toContain('name="hd_website"');
    expect(html).not.toContain('<script');
  });

  it('escapes everything that came from outside', () => {
    const html = renderWebFormPage(
      view(
        {
          ...FORM,
          fields: [
            { field: 'name', label: '<b>Name</b>', type: 'name', required: false, options: [] },
          ],
          values: new Map([['name', ['"><script>alert(1)</script>']]]),
        },
        { brandName: 'A & <B>' },
      ),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(html).toContain('&lt;b&gt;Name&lt;/b&gt;');
    expect(html).toContain('A &amp; &lt;B&gt;');
  });

  it('puts the summary first, links it to each field and marks the fields invalid', () => {
    const html = renderWebFormPage(
      view({
        ...FORM,
        values: new Map([
          ['email', ['omar@example']],
          ['custom:areas', ['Login']],
          ['custom:urgent', ['on']],
          ['custom:plan', ['Team']],
        ]),
        fieldErrors: new Map([
          ['email', 'email'],
          ['attachments', 'file_type'],
        ]),
      }),
    );

    expect(html).toContain('role="alert" tabindex="-1" autofocus');
    expect(html).toContain('2 fields need attention');
    expect(html).toContain(
      '<a href="#wf-email">Email</a><a href="#wf-attachments">Attachments</a>',
    );
    expect(html).toContain(
      'value="omar@example" required aria-invalid="true" aria-describedby="wf-email-e"',
    );
    expect(html).toContain('<p class="hd-error" id="wf-email-e">');
    expect(html).toContain('aria-describedby="wf-attachments-h wf-attachments-e"');
    expect(html).toContain('value="Login" checked');
    expect(html).toContain('<option value="Team" selected>');
    expect(html).toMatch(/name="custom:urgent" value="on" checked/);
  });

  it('shows a form-level refusal when no field is to blame', () => {
    const html = renderWebFormPage(view({ ...FORM, formError: 'rate_limited' }));

    expect(html).toContain('Too many messages from here.');
  });

  it('draws the CAPTCHA container and loads its script under the nonce', () => {
    const html = renderWebFormPage(
      view({
        ...FORM,
        captcha: {
          provider: 'turnstile',
          siteKey: 'site-key',
          scriptUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
          widgetClass: 'cf-turnstile',
          responseField: 'cf-turnstile-response',
          csp: { scriptSrc: [], frameSrc: [], styleSrc: [], connectSrc: [] },
        },
      }),
    );

    expect(html).toContain('<div class="cf-turnstile" data-sitekey="site-key" data-language="en">');
    expect(html).toContain(
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer nonce="n0nce">',
    );
  });

  it('shows the reference and the brand’s message, and links the help center it came from', () => {
    const html = renderWebFormPage(
      view(
        { kind: 'success', reference: 'HD-1042', thankYou: 'Your reference is {{ticket.number}}.' },
        { helpCenterHref: '/' },
      ),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('Your reference is <bdi class="mono">HD-1042</bdi>');
    expect(html).toContain('<p class="hd-secondary">Your reference is HD-1042.</p>');
    expect(html).toContain('<a href="/">Browse the help center</a>');
    expect(html).toContain('<a href="/contact/brand-1?lang=en">Send another message</a>');
  });

  it('lays the Arabic page out right to left, with the English link in its own language', () => {
    const html = renderWebFormPage(view({ kind: 'closed' }, { locale: 'ar' }));

    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('هذا النموذج مغلق');
    expect(html).toContain('lang="en" hreflang="en">English</a>');
  });

  it('draws no header on the page that names no brand', () => {
    const html = renderWebFormPage(view({ kind: 'not_found' }, { brandName: null }));

    expect(html).not.toContain('<header');
    expect(html).toContain('<title>Page not found</title>');
  });

  it('says so when the form cannot take messages', () => {
    expect(renderWebFormPage(view({ kind: 'unavailable' }))).toContain(
      'This form is not available',
    );
  });
});

describe('fieldId', () => {
  it('turns a reference into an id the summary can link to', () => {
    expect(fieldId('custom:order_number')).toBe('wf-custom-order_number');
    expect(fieldId('email')).toBe('wf-email');
  });
});

describe('thankYouText', () => {
  it('replaces every placeholder and nothing else', () => {
    expect(thankYouText('{{ticket.number}} / {{ticket.number}} {{other}}', 'HD-1')).toBe(
      'HD-1 / HD-1 {{other}}',
    );
  });
});
