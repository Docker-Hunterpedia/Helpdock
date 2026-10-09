import { defineWidgetElement, ELEMENT_NAME, installCommandApi } from '../src/embed.js';
import {
  LINA,
  SAMPLE_AI_ANSWER,
  SAMPLE_AI_HANDOFF,
  type SampleOptions,
  sampleMockOptions,
} from '../src/transport/fixtures.js';
import { MockTransport } from '../src/transport/mock.js';
import type { WidgetLocale, WidgetMode } from '../src/transport/types.js';

/**
 * The widget on an otherwise empty page, wired to the mock transport and
 * configured from the query string, e.g.
 * `/?locale=ar&mode=chat_articles&availability=closed&prechat=1`. The mock is
 * exposed as `window.helpdock` so a Playwright test can play the agent side
 * and the network.
 */
const params = new URLSearchParams(location.search);
const locale: WidgetLocale = params.get('locale') === 'ar' ? 'ar' : 'en';
document.documentElement.lang = locale;
document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';

const options: SampleOptions = {
  mode: (params.get('mode') as WidgetMode | null) ?? 'chat',
  availability: (params.get('availability') as SampleOptions['availability']) ?? 'online',
  preChat: params.get('prechat') === '1',
  transcript: params.get('transcript') !== '0',
  scheme: (params.get('scheme') as SampleOptions['scheme']) ?? 'light',
};

// `hours=never`: the team is away and its calendar never opens. `hours=absent`:
// a server older than M7-06, which sends no hours with a conversation.
const hoursParam = params.get('hours');
const mock = new MockTransport({
  ...sampleMockOptions(locale, options),
  ...(hoursParam === 'never'
    ? { hours: { open: false, next_open_at: null, timezone: 'Asia/Dubai' } }
    : hoursParam === 'absent'
      ? { hours: null }
      : {}),
});
Object.assign(window, {
  helpdock: {
    mock,
    agent: LINA,
    ai: { answer: SAMPLE_AI_ANSWER[locale], handoff: SAMPLE_AI_HANDOFF[locale] },
  },
});

defineWidgetElement({ createTransport: () => mock, pageLocale: () => locale });
installCommandApi(window as unknown as Record<string, unknown>);

const element = document.createElement(ELEMENT_NAME);
element.setAttribute('brand', 'helpdock');
element.setAttribute('locale', locale);
document.body.append(element);
