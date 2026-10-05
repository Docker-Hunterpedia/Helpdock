import { createKeyring } from '@helpdock/config';
import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { CSAT_BRAND, CSAT_SURVEY, csatSurveyRow } from '../testing/csat-doubles.js';
import { deliveryRow } from '../testing/email-fixtures.js';
import type { CsatRepository } from './csat.repository.js';
import { CsatEmailSource } from './csat-email.js';
import { CsatTokens, hashCsatToken } from './tokens.js';

const APP_URL = 'https://desk.example.com';
const tokens = new CsatTokens(
  createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 5).toString('base64') }),
);
const token = tokens.sign({ brandId: CSAT_BRAND, surveyId: CSAT_SURVEY });
const tx = {} as DbTransaction;

const source = ({
  tokenHash = hashCsatToken(token),
  closer,
}: {
  tokenHash?: string;
  closer?: string;
} = {}) =>
  new CsatEmailSource(
    {
      find: () => Promise.resolve(csatSurveyRow({ tokenHash })),
      closerName: () => Promise.resolve(closer),
      markSent: () => Promise.resolve(),
    } as Pick<CsatRepository, 'find' | 'closerName' | 'markSent'>,
    tokens,
    APP_URL,
  );

const surveyDelivery = (locale: 'en' | 'ar' = 'en') =>
  deliveryRow({ brandId: CSAT_BRAND, kind: 'csat', csatResponseId: CSAT_SURVEY, locale });

describe('CsatEmailSource', () => {
  it('links each score to the survey’s page with that score pressed, in the email’s language', async () => {
    const survey = await source().forDelivery(tx, surveyDelivery('ar'));

    expect(survey?.links).toEqual(
      [1, 2, 3, 4, 5].map((rating) => `${APP_URL}/csat/${token}?rating=${String(rating)}&lang=ar`),
    );
  });

  it('names the closer by first name, and nobody when the page may not', async () => {
    expect(
      (await source({ closer: 'Lina Haddad' }).forDelivery(tx, surveyDelivery()))?.closedBy,
    ).toBe('Lina');
    expect((await source().forDelivery(tx, surveyDelivery()))?.closedBy).toBeNull();
  });

  it('has nothing for a delivery that is not a survey’s, or a survey no key of ours signed', async () => {
    expect(await source().forDelivery(tx, deliveryRow())).toBeUndefined();
    expect(
      await source({ tokenHash: hashCsatToken('another') }).forDelivery(tx, surveyDelivery()),
    ).toBeUndefined();
  });
});
