import type { DnsAnswer } from '@helpdock/net';
import { describe, expect, it } from 'vitest';
import {
  applyTls,
  CHECK_INTERVALS_MS,
  CHECK_REQUEST_COOLDOWN_MS,
  checkIntervalFor,
  type DnsObservation,
  type DnsVerdict,
  decideCheck,
  evaluateDns,
  isCheckDue,
  mayRequestCheck,
} from './domain-rules.js';

const TARGET = 'edge.helpdock.example';
const TOKEN = 'tok123';
const NOW = new Date('2026-09-27T12:00:00Z');
const EARLIER = new Date('2026-09-27T11:00:00Z');
const MINUTE = 60_000;

const found = (...records: string[]): DnsAnswer => ({ status: 'found', records });
const ABSENT: DnsAnswer = { status: 'absent' };
const TIMEOUT: DnsAnswer = { status: 'failed', code: 'ETIMEOUT' };

const observe = (overrides: Partial<DnsObservation>): DnsObservation => ({
  cname: ABSENT,
  txt: ABSENT,
  addresses: ABSENT,
  targetAddresses: found('203.0.113.10'),
  ...overrides,
});

const evaluate = (overrides: Partial<DnsObservation>): DnsVerdict =>
  evaluateDns(observe(overrides), { token: TOKEN, cnameTarget: TARGET });

describe('evaluateDns', () => {
  it('verifies a domain with the token and a CNAME to the target', () => {
    expect(
      evaluate({ cname: found(TARGET), txt: found('other', `helpdock-verify=${TOKEN}`) }),
    ).toEqual({
      inconclusive: false,
      txtSeen: true,
      cnameSeen: true,
      cloudflareAddress: null,
      cnameElsewhere: null,
      verified: true,
    });
  });

  it('accepts an apex that points at the target by address instead of by CNAME', () => {
    const verdict = evaluate({
      addresses: found('203.0.113.10'),
      txt: found(`helpdock-verify=${TOKEN}`),
    });

    expect(verdict).toMatchObject({ cnameSeen: true, verified: true });
  });

  it('accepts a name Cloudflare proxies, whose CNAME is flattened away', () => {
    const verdict = evaluate({
      addresses: found('104.21.48.12'),
      txt: found(`helpdock-verify=${TOKEN}`),
    });

    expect(verdict).toMatchObject({
      cnameSeen: false,
      cloudflareAddress: '104.21.48.12',
      verified: true,
    });
  });

  it('never verifies without the token, however the name points', () => {
    expect(evaluate({ cname: found(TARGET), txt: found('helpdock-verify=wrong') })).toMatchObject({
      txtSeen: false,
      cnameSeen: true,
      verified: false,
    });
  });

  it('names a CNAME that points somewhere else', () => {
    expect(evaluate({ cname: found('shop.example.net') })).toMatchObject({
      cnameElsewhere: 'shop.example.net',
      verified: false,
    });
  });

  it('is inconclusive when the TXT lookup failed, or both pointing lookups did', () => {
    expect(evaluate({ txt: TIMEOUT }).inconclusive).toBe(true);
    expect(evaluate({ cname: TIMEOUT, addresses: TIMEOUT }).inconclusive).toBe(true);
    expect(evaluate({ cname: TIMEOUT, addresses: found('203.0.113.10') }).inconclusive).toBe(false);
  });
});

type Row = Parameters<typeof decideCheck>[0];

const pendingRow: Row = {
  verifiedAt: null,
  cnameSeenAt: null,
  txtSeenAt: null,
  tlsIssuedAt: null,
  cloudflareProxied: false,
  failureReason: null,
  failureDetail: null,
};

const verifiedRow: Row = {
  ...pendingRow,
  verifiedAt: EARLIER,
  cnameSeenAt: EARLIER,
  txtSeenAt: EARLIER,
  tlsIssuedAt: EARLIER,
};

const good = evaluate({ cname: found(TARGET), txt: found(`helpdock-verify=${TOKEN}`) });

describe('decideCheck', () => {
  it('verifies a pending domain and asks for a TLS handshake', () => {
    const decision = decideCheck(pendingRow, good, NOW);

    expect(decision.transition).toBe('verified');
    expect(decision.probeTls).toBe(true);
    expect(decision.update).toMatchObject({
      verifiedAt: NOW,
      cnameSeenAt: NOW,
      txtSeenAt: NOW,
      lastCheckedAt: NOW,
      failureReason: null,
    });
  });

  it('keeps a pending domain pending, recording which record was seen', () => {
    const decision = decideCheck(
      pendingRow,
      evaluate({ txt: found(`helpdock-verify=${TOKEN}`) }),
      NOW,
    );

    expect(decision).toMatchObject({ transition: null, probeTls: false });
    expect(decision.update).toMatchObject({ verifiedAt: null, txtSeenAt: NOW, cnameSeenAt: null });
  });

  it('fails a pending domain whose CNAME points elsewhere', () => {
    const decision = decideCheck(pendingRow, evaluate({ cname: found('shop.example.net') }), NOW);

    expect(decision.update).toMatchObject({
      failureReason: 'cname_mismatch',
      failureDetail: 'shop.example.net',
    });
  });

  it('changes nothing but the time on an inconclusive reading, even for a verified domain', () => {
    const decision = decideCheck(verifiedRow, evaluate({ txt: TIMEOUT }), NOW);

    expect(decision).toEqual({
      transition: null,
      probeTls: false,
      update: {
        verifiedAt: EARLIER,
        cnameSeenAt: EARLIER,
        txtSeenAt: EARLIER,
        tlsIssuedAt: EARLIER,
        lastCheckedAt: NOW,
        failureReason: null,
        failureDetail: null,
      },
    });
  });

  it('un-verifies a domain whose TXT record is gone', () => {
    const decision = decideCheck(verifiedRow, evaluate({ cname: found(TARGET) }), NOW);

    expect(decision.transition).toBe('verification_lost');
    expect(decision.update).toMatchObject({
      verifiedAt: null,
      tlsIssuedAt: null,
      failureReason: 'records_removed',
    });
  });

  it('keeps a verified domain verified, and probes TLS again', () => {
    const decision = decideCheck(verifiedRow, good, NOW);

    expect(decision).toMatchObject({ transition: null, probeTls: true });
    expect(decision.update).toMatchObject({ verifiedAt: EARLIER, tlsIssuedAt: EARLIER });
  });

  it('skips the handshake behind Cloudflare, where Cloudflare serves HTTPS', () => {
    const proxied = { ...pendingRow, cloudflareProxied: true };
    const decision = decideCheck(
      proxied,
      evaluate({ addresses: found('104.21.48.12'), txt: found(`helpdock-verify=${TOKEN}`) }),
      NOW,
    );

    expect(decision).toMatchObject({ transition: 'verified', probeTls: false });
    expect(decision.update.failureReason).toBeNull();
  });

  it('says why no certificate can be issued for a proxied name that is not flagged', () => {
    const decision = decideCheck(
      pendingRow,
      evaluate({ addresses: found('104.21.48.12'), txt: found(`helpdock-verify=${TOKEN}`) }),
      NOW,
    );

    expect(decision).toMatchObject({ transition: 'verified', probeTls: false });
    expect(decision.update).toMatchObject({
      verifiedAt: NOW,
      failureReason: 'cloudflare_not_flagged',
      failureDetail: '104.21.48.12',
    });
  });
});

describe('applyTls', () => {
  const update = decideCheck(pendingRow, good, NOW).update;

  it('stamps the first valid certificate and clears a failure', () => {
    expect(
      applyTls(
        { ...update, failureReason: 'certificate_failed', failureDetail: 'x' },
        { status: 'valid', validTo: NOW },
        NOW,
      ),
    ).toMatchObject({ tlsIssuedAt: NOW, failureReason: null, failureDetail: null });
  });

  it('keeps the first issue time on a later valid handshake', () => {
    expect(
      applyTls({ ...update, tlsIssuedAt: EARLIER }, { status: 'valid', validTo: NOW }, NOW)
        .tlsIssuedAt,
    ).toEqual(EARLIER);
  });

  it('records a refused or failed handshake as a certificate failure, with its code', () => {
    expect(applyTls(update, { status: 'invalid', code: 'CERT_HAS_EXPIRED' }, NOW)).toMatchObject({
      failureReason: 'certificate_failed',
      failureDetail: 'CERT_HAS_EXPIRED',
    });
    expect(applyTls(update, { status: 'unreachable', code: 'timeout' }, NOW)).toMatchObject({
      failureReason: 'certificate_failed',
      failureDetail: 'timeout',
    });
  });
});

describe('the re-check schedule', () => {
  const base = {
    verifiedAt: null,
    createdAt: new Date(NOW.getTime() - 60 * MINUTE),
    cloudflareProxied: false,
    tlsIssuedAt: null,
    failureReason: null,
    lastCheckedAt: null,
  } as const;

  it('checks a pending domain every fifteen minutes for two days, then every six hours', () => {
    expect(checkIntervalFor(base, NOW)).toBe(CHECK_INTERVALS_MS.pendingFresh);
    expect(
      checkIntervalFor({ ...base, createdAt: new Date(NOW.getTime() - 3 * 86_400_000) }, NOW),
    ).toBe(CHECK_INTERVALS_MS.pendingStale);
  });

  it('checks a verified domain hourly until HTTPS is confirmed, then daily', () => {
    expect(checkIntervalFor({ ...base, verifiedAt: EARLIER }, NOW)).toBe(
      CHECK_INTERVALS_MS.verifiedUnconfirmed,
    );
    expect(checkIntervalFor({ ...base, verifiedAt: EARLIER, tlsIssuedAt: EARLIER }, NOW)).toBe(
      CHECK_INTERVALS_MS.verifiedHealthy,
    );
    expect(checkIntervalFor({ ...base, verifiedAt: EARLIER, cloudflareProxied: true }, NOW)).toBe(
      CHECK_INTERVALS_MS.verifiedHealthy,
    );
    expect(
      checkIntervalFor(
        {
          ...base,
          verifiedAt: EARLIER,
          tlsIssuedAt: EARLIER,
          failureReason: 'certificate_failed',
        },
        NOW,
      ),
    ).toBe(CHECK_INTERVALS_MS.verifiedUnconfirmed);
  });

  it('is due when never checked, or a minute before its interval runs out', () => {
    expect(isCheckDue(base, NOW)).toBe(true);
    expect(isCheckDue({ ...base, lastCheckedAt: new Date(NOW.getTime() - 14 * MINUTE) }, NOW)).toBe(
      true,
    );
    expect(isCheckDue({ ...base, lastCheckedAt: new Date(NOW.getTime() - 5 * MINUTE) }, NOW)).toBe(
      false,
    );
  });
});

describe('mayRequestCheck', () => {
  it('lets a press through once the cooldown has passed', () => {
    expect(mayRequestCheck({ checkRequestedAt: null }, NOW)).toBe(true);
    expect(
      mayRequestCheck(
        { checkRequestedAt: new Date(NOW.getTime() - CHECK_REQUEST_COOLDOWN_MS) },
        NOW,
      ),
    ).toBe(true);
    expect(mayRequestCheck({ checkRequestedAt: new Date(NOW.getTime() - 1_000) }, NOW)).toBe(false);
  });
});
