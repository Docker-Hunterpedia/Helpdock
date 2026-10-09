import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { translatorFor } from '../i18n/catalogs.js';
import type { WidgetController } from '../state/controller.js';
import { WidgetContext } from './context.js';
import { Sentence } from './Sentence.js';

afterEach(cleanup);

const sentence = (locale: 'en' | 'ar', isolate: readonly string[]) =>
  render(
    <WidgetContext.Provider
      value={{ controller: {} as WidgetController, t: translatorFor(locale), locale }}
    >
      <p>
        <Sentence
          id="form.sentBody"
          vars={{ ref: 'HD-1042', email: 'omar.k@example.com' }}
          isolate={isolate}
        />
      </p>
    </WidgetContext.Provider>,
  ).container.querySelector('p') as HTMLElement;

describe('Sentence', () => {
  it('sets only the named values apart, and the sentence reads as the catalog wrote it', () => {
    const paragraph = sentence('ar', ['ref', 'email']);

    expect([...paragraph.querySelectorAll('bdi')].map((value) => value.textContent)).toEqual([
      'HD-1042',
      'omar.k@example.com',
    ]);
    expect(paragraph.textContent).toBe('رقم مرجعك HD-1042. سنرد على omar.k@example.com.');
  });

  it('leaves a value that is not named as plain text', () => {
    const paragraph = sentence('en', ['email']);

    expect([...paragraph.querySelectorAll('bdi')].map((value) => value.textContent)).toEqual([
      'omar.k@example.com',
    ]);
    expect(paragraph.textContent).toBe(
      'Your reference is HD-1042. We will reply to omar.k@example.com.',
    );
  });
});
