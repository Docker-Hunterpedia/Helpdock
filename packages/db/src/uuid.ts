import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562 §5.7): a 48-bit millisecond timestamp, a 12-bit counter in
 * `rand_a`, and 62 bits of randomness in `rand_b`. Time-ordered ids keep B-tree
 * inserts at the right edge of the index, which is why ARCHITECTURE §5 asks for
 * them. Node's `crypto.randomUUID()` is v4 and unordered, so this is hand-rolled
 * rather than delegated.
 */

const UUID_BYTES = 16;
const TIMESTAMP_BYTES = 6;
const VERSION_7 = 0x70;
const VARIANT_RFC9562 = 0x80;
const VARIANT_MASK = 0x3f;
const BYTE_MASK = 0xff;
const MAX_COUNTER = 0xfff;
/**
 * The counter is seeded with 10 random bits rather than 12, so 1,024 ids can be
 * drawn in one millisecond before it rolls into the next (RFC 9562 §6.2, the
 * seeded "fixed-length dedicated counter" method).
 */
const COUNTER_SEED_HIGH_MASK = 0x03;
const RANDOM_BYTES = 10;

let lastMs = 0;
let lastCounter = 0;

/**
 * Returns a lower-case UUIDv7. Ids drawn in the same millisecond, or while the
 * clock steps backwards, stay strictly increasing: the counter advances instead
 * of the timestamp and borrows a millisecond when it overflows.
 */
export const uuidv7 = (): string => {
  const random = randomBytes(RANDOM_BYTES);
  const now = Date.now();

  let ms: number;
  let counter: number;
  if (now > lastMs) {
    ms = now;
    counter = ((random.readUInt8(0) & COUNTER_SEED_HIGH_MASK) << 8) | random.readUInt8(1);
  } else {
    ms = lastMs;
    counter = lastCounter + 1;
    if (counter > MAX_COUNTER) {
      ms = lastMs + 1;
      counter = 0;
    }
  }
  lastMs = ms;
  lastCounter = counter;

  const bytes = Buffer.alloc(UUID_BYTES);
  bytes.writeUIntBE(ms, 0, TIMESTAMP_BYTES);
  bytes.writeUInt8(VERSION_7 | (counter >> 8), 6);
  bytes.writeUInt8(counter & BYTE_MASK, 7);
  bytes.writeUInt8(VARIANT_RFC9562 | (random.readUInt8(2) & VARIANT_MASK), 8);
  random.copy(bytes, 9, 3, RANDOM_BYTES);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string is a UUID of any version. Postgres accepts any value of this
 * shape, so this is the check that guards a value on its way into a `uuid`
 * column or into an `app.*` session setting.
 */
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

/** The millisecond an id was drawn in. Used by the tests and when debugging. */
export const uuidv7Timestamp = (id: string): number =>
  Buffer.from(id.replaceAll('-', '').slice(0, TIMESTAMP_BYTES * 2), 'hex').readUIntBE(
    0,
    TIMESTAMP_BYTES,
  );
