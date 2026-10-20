import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { hashToken, webauthnCeremonyKey } from '../redis-keys.js';

/**
 * The state of one WebAuthn ceremony, between handing the browser its options
 * and checking what the authenticator signed (ADR 0050).
 *
 * The rules are the ones every other auth token here follows:
 *
 * - **Single use.** Spending it is one `GETDEL`, before anything is checked,
 *   so a ceremony is gone whether the check then passes or fails, and two
 *   requests racing with the same id cannot both get it.
 * - **Short-lived.** Five minutes, the time a browser prompt plausibly stays
 *   open, and the `timeout` the options carry.
 * - **Never stored by its id.** The id is 256 random bits; Redis holds its
 *   SHA-256, so a dump of Redis yields nothing to present.
 * - **One purpose.** A challenge minted to register a passkey cannot answer a
 *   second-factor prompt, and so on; and where the ceremony belongs to a
 *   person or a browser session, it completes only for that one. Magic links
 *   and reset tokens hold the same rule (`email-token.store.ts`).
 */

export const WEBAUTHN_CEREMONY_PURPOSES = [
  'register',
  'second-factor',
  'passwordless',
  'step-up',
  'break-glass',
] as const;
export type WebAuthnCeremonyPurpose = (typeof WEBAUTHN_CEREMONY_PURPOSES)[number];

export const WEBAUTHN_CEREMONY_TTL_SECONDS = 300;

const ID_BYTES = 32;

const ceremonySchema = z.strictObject({
  purpose: z.enum(WEBAUTHN_CEREMONY_PURPOSES),
  /** base64url of 32 random bytes, as the options carried it. */
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** The RP ID the options named, so a ceremony begun before a re-pin cannot finish after it. */
  rpId: z.string().min(1).max(253),
  userId: z.uuid().optional(),
  familyId: z.string().min(1).max(128).optional(),
});

export type WebAuthnCeremony = z.infer<typeof ceremonySchema>;

/** Who a ceremony may complete for. Both are compared exactly: absent must meet absent. */
export interface WebAuthnCeremonyBinding {
  readonly userId?: string;
  readonly familyId?: string;
}

export class WebAuthnCeremonyStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /** Returns the ceremony id to hand the browser. It is never stored in this form. */
  async begin(ceremony: WebAuthnCeremony): Promise<string> {
    const id = randomBytes(ID_BYTES).toString('base64url');
    await this.#redis.set(
      webauthnCeremonyKey(hashToken(id)),
      JSON.stringify(ceremonySchema.parse(ceremony)),
      'EX',
      WEBAUTHN_CEREMONY_TTL_SECONDS,
    );
    return id;
  }

  /**
   * Spends the ceremony, or answers `null` when it is unknown, expired, already
   * spent, of another purpose, or bound to someone else. It is spent in every
   * one of those cases: a ceremony presented to the wrong endpoint is not
   * left lying around for the right one.
   */
  async consume(
    id: string,
    purpose: WebAuthnCeremonyPurpose,
    binding: WebAuthnCeremonyBinding = {},
  ): Promise<WebAuthnCeremony | null> {
    const raw = await this.#redis.getdel(webauthnCeremonyKey(hashToken(id)));
    if (raw === null) {
      return null;
    }

    let ceremony: WebAuthnCeremony;
    try {
      ceremony = ceremonySchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }

    const matches =
      ceremony.purpose === purpose &&
      ceremony.userId === binding.userId &&
      ceremony.familyId === binding.familyId;
    return matches ? ceremony : null;
  }
}
