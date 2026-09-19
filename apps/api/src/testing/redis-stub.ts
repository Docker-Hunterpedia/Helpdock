import type { Redis } from 'ioredis';

/**
 * An in-memory stand-in for the handful of Redis commands the auth service
 * uses, so its logic can be unit tested without a container.
 *
 * **What it is not.** `ioredis-mock` was the obvious candidate and was ruled
 * out: it declares `ioredis@^5` as a peer and this workspace is on 6. So this
 * is hand-written, and it is deliberately small — a command it does not
 * implement throws rather than quietly answering nothing, because a double that
 * invents behaviour is worse than no double.
 *
 * **Lua.** `eval` recognises the two scripts the auth code ships, by the exact
 * text those modules export, and performs the same sequence of commands through
 * this stub. That mirror is what makes the surrounding logic testable in
 * milliseconds; the scripts themselves are proved against a real Redis in
 * `src/auth/auth.integration.test.ts`, which runs the same scenarios. A script
 * this stub does not recognise throws, so editing the Lua without editing the
 * mirror fails the unit suite rather than passing it by accident.
 *
 * Expiry is honoured lazily, on read, which is what Redis does too. Time comes
 * from `Date.now()`, so a test that cares about expiry moves the clock with
 * `vi.setSystemTime` or passes a short TTL and waits.
 */

type Value =
  | { readonly kind: 'string'; value: string }
  | { readonly kind: 'hash'; value: Map<string, string> }
  | { readonly kind: 'set'; value: Set<string> }
  | { readonly kind: 'zset'; value: Map<string, number> };

interface Entry {
  data: Value;
  /** Epoch milliseconds, or null for "no expiry". */
  expiresAt: number | null;
}

export interface PublishedMessage {
  readonly channel: string;
  readonly message: string;
}

/** The scripts this stub knows, mapped to the sequence they perform. */
export type ScriptMirror = (
  stub: RedisStub,
  keys: readonly string[],
  args: readonly string[],
) => Promise<unknown>;

export class RedisStub {
  readonly #entries = new Map<string, Entry>();
  readonly #scripts = new Map<string, ScriptMirror>();
  readonly published: PublishedMessage[] = [];

  /** Registers the JavaScript mirror of one Lua script. */
  defineScript(lua: string, mirror: ScriptMirror): this {
    this.#scripts.set(lua, mirror);
    return this;
  }

  /** The stub, typed as the client the services take. */
  asRedis(): Redis {
    // The stub implements the commands the auth code calls and nothing else, so
    // it is not a `Redis` and cannot pretend to be one by structure.
    return this as unknown as Redis;
  }

  /** Test scaffolding: every live key, for asserting that something was cleaned up. */
  keys(): string[] {
    return [...this.#entries.keys()].filter((key) => this.#live(key) !== undefined);
  }

  ttlOf(key: string): number | null {
    const entry = this.#live(key);
    if (entry === undefined || entry.expiresAt === null) {
      return null;
    }

    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }

  // -- strings -------------------------------------------------------

  async get(key: string): Promise<string | null> {
    const entry = this.#live(key);
    return entry?.data.kind === 'string' ? entry.data.value : null;
  }

  async set(key: string, value: string, ...options: unknown[]): Promise<'OK' | null> {
    const flags = options.map((option) => String(option).toUpperCase());
    const existing = this.#live(key);

    if (flags.includes('NX') && existing !== undefined) {
      return null;
    }

    const seconds = this.#secondsIn(flags, options);
    const expiresAt =
      seconds !== undefined
        ? Date.now() + seconds * 1000
        : flags.includes('KEEPTTL')
          ? (existing?.expiresAt ?? null)
          : null;

    this.#entries.set(key, { data: { kind: 'string', value }, expiresAt });
    return 'OK';
  }

  async getdel(key: string): Promise<string | null> {
    const value = await this.get(key);
    this.#entries.delete(key);
    return value;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.#live(key) !== undefined) {
        removed += 1;
      }
      this.#entries.delete(key);
    }

    return removed;
  }

  async exists(key: string): Promise<number> {
    return this.#live(key) === undefined ? 0 : 1;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.#live(key);
    if (entry === undefined) {
      return 0;
    }

    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async pexpire(key: string, milliseconds: number): Promise<number> {
    return this.expire(key, milliseconds / 1000);
  }

  // -- hashes --------------------------------------------------------

  async hset(key: string, ...rest: unknown[]): Promise<number> {
    const hash = this.#entryOf(key, 'hash');
    const fields = toFieldMap(rest);
    for (const [field, value] of fields) {
      hash.set(field, value);
    }

    return fields.size;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const entry = this.#live(key);
    return entry?.data.kind === 'hash' ? (entry.data.value.get(field) ?? null) : null;
  }

  // -- sets ----------------------------------------------------------

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.#entryOf(key, 'set');
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }

    return added;
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.#live(key);
    return entry?.data.kind === 'set' ? [...entry.data.value] : [];
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const entry = this.#live(key);
    if (entry?.data.kind !== 'set') {
      return 0;
    }

    let removed = 0;
    for (const member of members) {
      removed += entry.data.value.delete(member) ? 1 : 0;
    }

    return removed;
  }

  /** One pass returns everything: the auth code only uses `SCAN` to walk a prefix. */
  async scan(_cursor: string, ...options: unknown[]): Promise<[string, string[]]> {
    const matchIndex = options.findIndex((option) => String(option).toUpperCase() === 'MATCH');
    const pattern = matchIndex === -1 ? '*' : String(options[matchIndex + 1]);
    const matcher = new RegExp(
      `^${pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '.*' : `\\${char}`))}$`,
    );

    return ['0', this.keys().filter((key) => matcher.test(key))];
  }

  // -- sorted sets ---------------------------------------------------

  async zadd(key: string, score: number | string, member: string): Promise<number> {
    const zset = this.#entryOf(key, 'zset');
    const existed = zset.has(member);
    zset.set(member, Number(score));

    return existed ? 0 : 1;
  }

  async zcard(key: string): Promise<number> {
    const entry = this.#live(key);
    return entry?.data.kind === 'zset' ? entry.data.value.size : 0;
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
    const entry = this.#live(key);
    if (entry?.data.kind !== 'zset') {
      return 0;
    }

    let removed = 0;
    for (const [member, score] of entry.data.value) {
      if (score >= Number(min) && score <= Number(max)) {
        entry.data.value.delete(member);
        removed += 1;
      }
    }

    return removed;
  }

  // -- pub/sub -------------------------------------------------------

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return 1;
  }

  // -- scripting -----------------------------------------------------

  async eval(script: string, numberOfKeys: number, ...rest: (string | number)[]): Promise<unknown> {
    const mirror = this.#scripts.get(script);
    if (mirror === undefined) {
      throw new Error(
        'RedisStub.eval was given a script it has no mirror for. Register it with defineScript, or use the integration suite.',
      );
    }

    const values = rest.map(String);
    return mirror(this, values.slice(0, numberOfKeys), values.slice(numberOfKeys));
  }

  /** Every command in one go. The stub has no transactions, so order is enough. */
  multi(): ChainableStub {
    return new ChainableStub(this);
  }

  // -- internals -----------------------------------------------------

  #live(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }

    return entry;
  }

  #entryOf(key: string, kind: 'hash'): Map<string, string>;
  #entryOf(key: string, kind: 'set'): Set<string>;
  #entryOf(key: string, kind: 'zset'): Map<string, number>;
  #entryOf(key: string, kind: 'hash' | 'set' | 'zset'): unknown {
    const entry = this.#live(key);
    if (entry !== undefined && entry.data.kind === kind) {
      return entry.data.value;
    }

    const created: Value =
      kind === 'hash'
        ? { kind: 'hash', value: new Map() }
        : kind === 'set'
          ? { kind: 'set', value: new Set() }
          : { kind: 'zset', value: new Map() };

    this.#entries.set(key, { data: created, expiresAt: null });
    return created.value;
  }

  #secondsIn(flags: string[], options: unknown[]): number | undefined {
    const index = flags.indexOf('EX');
    return index === -1 ? undefined : Number(options[index + 1]);
  }
}

/** What `multi()` returns: the same commands, queued, run on `exec()`. */
class ChainableStub {
  readonly #stub: RedisStub;
  readonly #queue: (() => Promise<unknown>)[] = [];

  constructor(stub: RedisStub) {
    this.#stub = stub;
  }

  hset(...args: Parameters<RedisStub['hset']>): this {
    return this.#queued(() => this.#stub.hset(...args));
  }

  set(...args: Parameters<RedisStub['set']>): this {
    return this.#queued(() => this.#stub.set(...args));
  }

  sadd(...args: Parameters<RedisStub['sadd']>): this {
    return this.#queued(() => this.#stub.sadd(...args));
  }

  srem(...args: Parameters<RedisStub['srem']>): this {
    return this.#queued(() => this.#stub.srem(...args));
  }

  del(...args: Parameters<RedisStub['del']>): this {
    return this.#queued(() => this.#stub.del(...args));
  }

  expire(...args: Parameters<RedisStub['expire']>): this {
    return this.#queued(() => this.#stub.expire(...args));
  }

  async exec(): Promise<[null, unknown][]> {
    const results: [null, unknown][] = [];
    for (const run of this.#queue) {
      results.push([null, await run()]);
    }

    return results;
  }

  #queued(run: () => Promise<unknown>): this {
    this.#queue.push(run);
    return this;
  }
}

/** `hset(key, { a: 1 })` and `hset(key, 'a', 1, 'b', 2)` are both valid ioredis. */
const toFieldMap = (rest: unknown[]): Map<string, string> => {
  const fields = new Map<string, string>();
  const [first] = rest;

  if (rest.length === 1 && typeof first === 'object' && first !== null) {
    for (const [field, value] of Object.entries(first)) {
      fields.set(field, String(value));
    }
    return fields;
  }

  for (let index = 0; index + 1 < rest.length; index += 2) {
    fields.set(String(rest[index]), String(rest[index + 1]));
  }

  return fields;
};
