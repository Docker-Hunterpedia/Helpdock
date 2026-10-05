import { describe, expect, it } from 'vitest';
import { type CsatSurveyBody, renderCsatSurveyBody } from './csat-survey.js';

const WORDS = ['Very bad', 'Bad', 'Okay', 'Good', 'Excellent'];

const body = (overrides: Partial<CsatSurveyBody> = {}): CsatSurveyBody => ({
  greeting: 'Hi Mona,',
  intro: 'Lina closed your request HD-1042 today. We would like to know how it went.',
  reference: 'HD-1042',
  question: 'How would you rate the help you received?',
  choices: WORDS.map((word, index) => ({
    rating: index + 1,
    word,
    href: `https://desk.example.com/csat/tok?rating=${String(index + 1)}&lang=en`,
    label: `Rate ${String(index + 1)} out of 5, ${word}`,
  })),
  hint: 'Choose a number to open the survey page with it already selected.',
  ...overrides,
});

describe('renderCsatSurveyBody', () => {
  it('draws five labelled links in order, each opening the page with its score', () => {
    const { bodyHtml } = renderCsatSurveyBody(body());
    const links = [...bodyHtml.matchAll(/<a href="([^"]+)" aria-label="([^"]+)"/g)];

    expect(links.map((link) => link[2])).toEqual(
      WORDS.map((word, index) => `Rate ${String(index + 1)} out of 5, ${word}`),
    );
    expect(links[3]?.[1]).toBe('https://desk.example.com/csat/tok?rating=4&amp;lang=en');
  });

  it('sets the question as the h1 and the reference in mono inside the intro', () => {
    const { bodyHtml } = renderCsatSurveyBody(body());

    expect(bodyHtml).toContain('How would you rate the help you received?</h1>');
    expect(bodyHtml).toMatch(/your request <bdi style="font-family:[^"]+">HD-1042<\/bdi> today/);
  });

  it('escapes what it is given', () => {
    const { bodyHtml } = renderCsatSurveyBody(body({ greeting: 'Hi <b>Mona</b>,' }));

    expect(bodyHtml).toContain('Hi &lt;b&gt;Mona&lt;/b&gt;,');
  });

  it('lists one link per score in the plain-text part, aligned after the words', () => {
    const { bodyText } = renderCsatSurveyBody(body());
    const lines = bodyText.split('\n').filter((line) => line.includes('/csat/'));

    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('1 · Very bad   https://desk.example.com/csat/tok?rating=1&lang=en');
    expect(lines[4]?.indexOf('https')).toBe(lines[0]?.indexOf('https'));
  });
});
