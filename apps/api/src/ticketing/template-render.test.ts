import { describe, expect, it } from 'vitest';
import {
  isTemplatePlaceholder,
  paragraphsFrom,
  renderTemplate,
  splitName,
  templateValues,
} from './template-render.js';

const values = templateValues({
  brand: { name: 'Helpdock' },
  contact: { name: 'Mona Khalil Saad', email: 'mona@example.com' },
  ticket: { number: 'HD-1042' },
});

describe('splitName', () => {
  it('takes the first word as the first name and the rest as the last', () => {
    expect(splitName('Mona Khalil Saad')).toEqual({ first: 'Mona', last: 'Khalil Saad' });
  });

  it('treats a single word as a first name with no last name', () => {
    expect(splitName('Mona')).toEqual({ first: 'Mona', last: '' });
  });

  it('survives a name that is only whitespace', () => {
    expect(splitName('   ')).toEqual({ first: '', last: '' });
  });
});

describe('renderTemplate', () => {
  it('fills the names it knows', () => {
    expect(renderTemplate('Hi {{contact.first_name}}, this is {{brand.name}}.', values).text).toBe(
      'Hi Mona, this is Helpdock.',
    );
  });

  it('fills the ticket number', () => {
    expect(renderTemplate('Re: {{ticket.number}}', values).text).toBe('Re: HD-1042');
  });

  it('tolerates spaces inside the braces', () => {
    expect(renderTemplate('{{  brand.name  }}', values).text).toBe('Helpdock');
  });

  it('is case-insensitive about the name', () => {
    expect(renderTemplate('{{BRAND.NAME}}', values).text).toBe('Helpdock');
  });

  it('leaves a placeholder it does not know exactly as written, and reports it', () => {
    // An author who typed `{{contcat.name}}` has to see their typo. An empty
    // string would hide it until a customer read the sentence with a hole in it.
    const rendered = renderTemplate('Hi {{contcat.name}}', values);

    expect(rendered.text).toBe('Hi {{contcat.name}}');
    expect(rendered.unknown).toEqual(['contcat.name']);
  });

  it('reports each unknown placeholder once, however often it appears', () => {
    expect(renderTemplate('{{a.b}} {{a.b}}', values).unknown).toEqual(['a.b']);
  });

  describe('is not an expression language', () => {
    it.each([
      '{{constructor.constructor}}',
      '{{constructor}}',
      '{{__proto__}}',
      '{{__proto__.polluted}}',
      '{{toString}}',
      '{{valueOf}}',
      '{{hasOwnProperty}}',
    ])('leaves %s alone', (source) => {
      // The names are a `Map`, which has no prototype to inherit these from, so
      // there is nothing here to answer with even by accident.
      expect(renderTemplate(source, values).text).toBe(source);
    });

    it('does not walk a deeper path', () => {
      expect(renderTemplate('{{contact.name.length}}', values).text).toBe(
        '{{contact.name.length}}',
      );
    });

    it('does not expand a value that itself looks like a placeholder', () => {
      // One pass, and the replacement is a function, so there is no second pass
      // for an inserted `{{…}}` to be found in.
      const awkward = templateValues({
        brand: { name: '{{contact.email}}' },
        contact: { name: 'Mona', email: 'mona@example.com' },
      });

      expect(renderTemplate('{{brand.name}}', awkward).text).toBe('{{contact.email}}');
    });

    it('does not read `$&` in a value as a replacement pattern', () => {
      const awkward = templateValues({ brand: { name: '$& $1 $`' } });

      expect(renderTemplate('{{brand.name}}', awkward).text).toBe('$& $1 $`');
    });
  });

  describe('without a subject to fill from', () => {
    const bare = templateValues({ brand: { name: 'Helpdock' } });

    it('leaves the contact placeholders spelled out', () => {
      expect(renderTemplate('Hi {{contact.first_name}}', bare).text).toBe(
        'Hi {{contact.first_name}}',
      );
    });

    it('leaves the ticket number spelled out, which is what a preview shows', () => {
      expect(renderTemplate('{{ticket.number}}', bare).unknown).toEqual(['ticket.number']);
    });
  });

  it('renders a known placeholder with no value as nothing, not as a typo', () => {
    const noAddress = templateValues({
      brand: { name: 'Helpdock' },
      contact: { name: 'Mona', email: null },
    });
    const rendered = renderTemplate('<{{contact.email}}>', noAddress);

    expect(rendered.text).toBe('<>');
    expect(rendered.unknown).toEqual([]);
  });
});

describe('isTemplatePlaceholder', () => {
  it('knows the six names the renderer fills', () => {
    expect(isTemplatePlaceholder('brand.name')).toBe(true);
    expect(isTemplatePlaceholder('constructor')).toBe(false);
  });
});

describe('paragraphsFrom', () => {
  it('wraps a blank-line-separated block in a paragraph', () => {
    expect(paragraphsFrom('One.\n\nTwo.')).toBe('<p>One.</p><p>Two.</p>');
  });

  it('keeps a single newline inside a paragraph as a break', () => {
    expect(paragraphsFrom('One.\nStill one.')).toBe('<p>One.<br>Still one.</p>');
  });

  it('escapes markup, so a pasted error message is text and not a tag', () => {
    expect(paragraphsFrom('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('escapes quotes and ampersands too', () => {
    expect(paragraphsFrom(`a & "b" & 'c'`)).toBe('<p>a &amp; &quot;b&quot; &amp; &#39;c&#39;</p>');
  });

  it('drops blank blocks rather than emitting empty paragraphs', () => {
    expect(paragraphsFrom('One.\n\n   \n\nTwo.')).toBe('<p>One.</p><p>Two.</p>');
  });

  it('handles Windows line endings', () => {
    expect(paragraphsFrom('One.\r\n\r\nTwo.')).toBe('<p>One.</p><p>Two.</p>');
  });
});
