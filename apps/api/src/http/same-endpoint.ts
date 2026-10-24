/**
 * Whether two stored or submitted URLs name the same endpoint: scheme, host,
 * port, path and query, ignoring case in scheme and host, a default port and a
 * trailing slash. A stored secret may only follow an endpoint that is the same
 * by this test (#399); anything that does not parse counts as different.
 */
export const sameEndpoint = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) {
    return a === b;
  }
  const left = canonical(a);
  const right = canonical(b);

  return left !== undefined && left === right;
};

const canonical = (raw: string): string | undefined => {
  try {
    const url = new URL(raw.trim());
    const path = url.pathname.replace(/\/+$/, '');

    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return undefined;
  }
};
