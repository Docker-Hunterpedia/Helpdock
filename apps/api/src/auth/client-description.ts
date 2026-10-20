/**
 * Where a security change came from, in the words the notice email uses
 * ("Chrome on macOS · 85.12.x.x"). Product names are the same in every
 * language, so they are not translated; how they are joined is, in the
 * `email` catalog.
 *
 * The address is cut to its network part: enough for the holder to see whether
 * the change came from where they were, not enough to put in front of anyone
 * else who reads a forwarded email.
 */

export interface ClientDescription {
  readonly browser?: string;
  readonly os?: string;
  readonly ip?: string;
}

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b|\biPad\b|\biPod\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

const firstMatch = (
  table: readonly (readonly [RegExp, string])[],
  userAgent: string,
): string | undefined => table.find(([pattern]) => pattern.test(userAgent))?.[1];

/** `85.12.x.x` for IPv4 and `2001:db8:x:x` for IPv6; undefined for anything else. */
export const truncateAddress = (address: string): string | undefined => {
  const plain = address.replace(/^::ffff:/i, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(plain);
  if (v4) {
    return `${v4[1]}.${v4[2]}.x.x`;
  }
  if (/^[0-9a-f:]+$/i.test(plain) && plain.includes(':')) {
    const groups = plain.split(':').filter((group) => group !== '');
    return groups.length >= 2 ? `${groups[0]}:${groups[1]}:x:x` : undefined;
  }
  return undefined;
};

export const describeClient = (
  userAgent: string | null | undefined,
  ip: string | null | undefined,
): ClientDescription => {
  const browser = userAgent ? firstMatch(BROWSERS, userAgent) : undefined;
  const os = userAgent ? firstMatch(SYSTEMS, userAgent) : undefined;
  const truncated = ip ? truncateAddress(ip) : undefined;
  return {
    ...(browser === undefined ? {} : { browser }),
    ...(os === undefined ? {} : { os }),
    ...(truncated === undefined ? {} : { ip: truncated }),
  };
};
