/**
 * The two conversions this module keeps doing. Prometheus wants seconds, Node's
 * clocks give milliseconds and nanoseconds, and three copies of `1000` is three
 * chances to divide by the wrong one.
 */

export const MILLIS_PER_SECOND = 1000;
export const NANOS_PER_MILLI = 1_000_000;

/** Milliseconds since `startedAt`, from `process.hrtime.bigint()`. */
export const millisSince = (startedAt: bigint): number =>
  Number(process.hrtime.bigint() - startedAt) / NANOS_PER_MILLI;
