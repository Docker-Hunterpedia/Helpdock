import type { NotificationKind } from '@helpdock/schemas';

/**
 * Right away pacing (M14-10, DOMAIN-RULES §20, ADR 0037) as pure functions of
 * a state, a configuration and a clock, so every rule here is provable on a
 * fake clock without Postgres or Redis.
 *
 * ```
 * first notification      →  email after the first wait (2 min), gathering
 * more while emails go    →  each next email waits a back-off step (10, 20, 40, 60, 60 … min)
 * two quiet hours         →  back to the first wait
 * mention, breach, escalation →  may cut the wait: every 5 min at most, 8 a day
 * every email, digests too →  at most 6 an hour and 40 a day
 * ```
 *
 * The hour and day windows start at the first email in them rather than on the
 * clock's hour, so a burst at 10:59 cannot spend two hours' allowance in two
 * minutes, and no time zone is involved.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The kinds that may cut the wait; the email lists them under "Needs you now". */
export const URGENT_KINDS: ReadonlySet<NotificationKind> = new Set([
  'mentioned',
  'sla_breached',
  'escalated',
]);

export const isUrgent = (kind: NotificationKind): boolean => URGENT_KINDS.has(kind);

/** The `notify.email.*` install settings, in milliseconds and counts. */
export interface PacingConfig {
  readonly firstWaitMs: number;
  readonly backoffMs: readonly number[];
  readonly quietResetMs: number;
  readonly urgentIntervalMs: number;
  readonly urgentPerDay: number;
  readonly perHour: number;
  readonly perDay: number;
}

export interface PacingState {
  /** How many back-off steps the next email has climbed; 0 is the first wait. */
  readonly step: number;
  /** The earliest the next Right away email may go, unless an urgent one cuts in. */
  readonly nextAllowedAt: Date | null;
  /** The last arrival or send; quiet is measured from here. */
  readonly quietSince: Date | null;
  readonly hourWindowStart: Date | null;
  readonly sentInHour: number;
  readonly dayWindowStart: Date | null;
  readonly sentInDay: number;
  readonly urgentSentInDay: number;
  readonly lastUrgentAt: Date | null;
}

export const INITIAL_PACING: PacingState = Object.freeze({
  step: 0,
  nextAllowedAt: null,
  quietSince: null,
  hourWindowStart: null,
  sentInHour: 0,
  dayWindowStart: null,
  sentInDay: 0,
  urgentSentInDay: 0,
  lastUrgentAt: null,
});

/** How an email that went counts: paced, cut short by an urgent row, or a digest. */
export type SendKind = 'paced' | 'urgent' | 'digest';

const later = (a: Date, b: Date | null): Date => (b !== null && b > a ? b : a);
const plus = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

const isQuiet = (config: PacingConfig, state: PacingState, now: Date): boolean =>
  state.quietSince === null || now.getTime() - state.quietSince.getTime() >= config.quietResetMs;

const windowOpen = (start: Date | null, length: number, at: Date): start is Date =>
  start !== null && at.getTime() < start.getTime() + length;

/**
 * The first instant on or after `at` that the hour and day caps allow an
 * email. Applying the day cap can move past the hour window's end and back,
 * so the two are applied until neither moves the time.
 */
export const capped = (config: PacingConfig, state: PacingState, at: Date): Date => {
  let result = at;
  for (let pass = 0; pass < 2; pass += 1) {
    if (windowOpen(state.hourWindowStart, HOUR_MS, result) && state.sentInHour >= config.perHour) {
      result = plus(state.hourWindowStart, HOUR_MS);
    }
    if (windowOpen(state.dayWindowStart, DAY_MS, result) && state.sentInDay >= config.perDay) {
      result = plus(state.dayWindowStart, DAY_MS);
    }
  }

  return result;
};

/**
 * A notification arrived at `now`. After two quiet hours the back-off starts
 * over, which is decided here rather than when the email goes: by then the
 * arrival itself has broken the quiet.
 */
export const afterArrival = (config: PacingConfig, state: PacingState, now: Date): PacingState =>
  isQuiet(config, state, now)
    ? { ...state, step: 0, nextAllowedAt: null, quietSince: now }
    : { ...state, quietSince: now };

/**
 * When a batch opened by an arrival at `now` should go: the first wait from
 * now, or later if the back-off or a cap says so. Call it with the state
 * {@link afterArrival} returned for the same arrival.
 */
export const plannedSendAt = (config: PacingConfig, state: PacingState, now: Date): Date =>
  capped(config, state, later(plus(now, config.firstWaitMs), state.nextAllowedAt));

/**
 * The earliest an urgent arrival at `now` may send, or null when today's
 * urgent allowance is spent and it waits like any other.
 */
export const urgentSendAt = (config: PacingConfig, state: PacingState, now: Date): Date | null => {
  const used = windowOpen(state.dayWindowStart, DAY_MS, now) ? state.urgentSentInDay : 0;
  if (used >= config.urgentPerDay) {
    return null;
  }

  const earliest =
    state.lastUrgentAt === null
      ? now
      : later(now, plus(state.lastUrgentAt, config.urgentIntervalMs));

  return capped(config, state, earliest);
};

/** Counts one email into the windows, opening a new window where the old one has run out. */
const counted = (state: PacingState, now: Date, urgent: boolean): PacingState => {
  const hourOpen = windowOpen(state.hourWindowStart, HOUR_MS, now);
  const dayOpen = windowOpen(state.dayWindowStart, DAY_MS, now);

  return {
    ...state,
    hourWindowStart: hourOpen ? state.hourWindowStart : now,
    sentInHour: (hourOpen ? state.sentInHour : 0) + 1,
    dayWindowStart: dayOpen ? state.dayWindowStart : now,
    sentInDay: (dayOpen ? state.sentInDay : 0) + 1,
    urgentSentInDay: (dayOpen ? state.urgentSentInDay : 0) + (urgent ? 1 : 0),
    lastUrgentAt: urgent ? now : state.lastUrgentAt,
  };
};

/**
 * The state after an email went at `now`. A paced or urgent email climbs one
 * back-off step and sets when the next may go; a digest only counts toward
 * the caps, because digests keep their own clock.
 */
export const afterSend = (
  config: PacingConfig,
  state: PacingState,
  now: Date,
  kind: SendKind,
): PacingState => {
  const next = counted(state, now, kind === 'urgent');
  if (kind === 'digest') {
    return next;
  }

  const last = config.backoffMs.length - 1;
  const wait = config.backoffMs[Math.min(state.step, last)] ?? config.firstWaitMs;

  return { ...next, step: state.step + 1, nextAllowedAt: plus(now, wait), quietSince: now };
};

// --------------------------------------------------------------- presence

/** How long a held email waits for its recipient to leave, at most (owner decision D-27). */
export const PRESENCE_HOLD_CAP_MS = 15 * MINUTE_MS;
/** How long they must have been away or offline before it goes. */
export const PRESENCE_AWAY_GRACE_MS = 5 * MINUTE_MS;
/** How often a held email looks again while they are online. */
export const PRESENCE_RECHECK_MS = MINUTE_MS;

export interface PresenceHold {
  /** When the hold began; null until the first time the send found them online. */
  readonly heldSince: Date | null;
  /** The last time the send found them online. */
  readonly seenOnlineAt: Date | null;
}

export type PresenceDecision =
  | { readonly kind: 'send' }
  | { readonly kind: 'hold'; readonly until: Date; readonly hold: PresenceHold };

/**
 * DOMAIN-RULES §20's presence hold. While the recipient is online (not away)
 * in the brand, a Right away email waits until they have been away or offline
 * for five minutes, or fifteen minutes in all, whichever is first. Without the
 * cap a tab left open all day would mean no email ever.
 *
 * "Away for five minutes" is measured from the last time this check found
 * them online, so it is accurate to {@link PRESENCE_RECHECK_MS}; someone never
 * found online is not held at all.
 */
export const presenceDecision = (
  status: 'online' | 'away' | 'offline',
  hold: PresenceHold,
  now: Date,
): PresenceDecision => {
  const deadline = hold.heldSince === null ? null : plus(hold.heldSince, PRESENCE_HOLD_CAP_MS);
  if (deadline !== null && now >= deadline) {
    return { kind: 'send' };
  }

  if (status === 'online') {
    const heldSince = hold.heldSince ?? now;
    const cap = plus(heldSince, PRESENCE_HOLD_CAP_MS);
    const recheck = plus(now, PRESENCE_RECHECK_MS);

    return {
      kind: 'hold',
      until: recheck < cap ? recheck : cap,
      hold: { heldSince, seenOnlineAt: now },
    };
  }

  if (hold.seenOnlineAt === null) {
    return { kind: 'send' };
  }

  const graceEnds = plus(hold.seenOnlineAt, PRESENCE_AWAY_GRACE_MS);
  if (now >= graceEnds) {
    return { kind: 'send' };
  }

  return {
    kind: 'hold',
    until: deadline !== null && deadline < graceEnds ? deadline : graceEnds,
    hold,
  };
};

/** The install settings, read in minutes, as the milliseconds the functions above take. */
export const pacingConfigFromMinutes = (minutes: {
  readonly firstWaitMinutes: number;
  readonly backoffMinutes: readonly number[];
  readonly quietResetMinutes: number;
  readonly urgentIntervalMinutes: number;
  readonly urgentPerDay: number;
  readonly perHour: number;
  readonly perDay: number;
}): PacingConfig => ({
  firstWaitMs: minutes.firstWaitMinutes * MINUTE_MS,
  backoffMs: minutes.backoffMinutes.map((value) => value * MINUTE_MS),
  quietResetMs: minutes.quietResetMinutes * MINUTE_MS,
  urgentIntervalMs: minutes.urgentIntervalMinutes * MINUTE_MS,
  urgentPerDay: minutes.urgentPerDay,
  perHour: minutes.perHour,
  perDay: minutes.perDay,
});
