/**
 * M4-03's allow-list check, in one place for the three doors ARCHITECTURE §6
 * names: the config, the visitor session and the Socket.IO handshake — and,
 * because they are the same widget on the same page, every other widget route.
 *
 * The `Origin` a browser sends is compared as a string with the stored,
 * normalised origins (`widgetOriginSchema`), which is exactly what a browser
 * would compare. A request with no `Origin` is refused too: every browser sends
 * one on a cross-origin fetch and on a WebSocket, so its absence means a
 * client that is not a page. A native app sends one of the brand's allowed
 * origins itself (`docs/guides/widget-protocol.md`) — which is also the honest
 * limit of the check: it keeps the widget off other people's sites, and it is
 * the visitor credential and the throttles that hold against anything that is
 * not a browser.
 */
export const originOf = (header: string | string[] | undefined): string | null => {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value === '' || value === 'null') {
    return null;
  }

  try {
    const url = new URL(value);
    return url.origin === 'null' ? null : url.origin;
  } catch {
    return null;
  }
};

export const isOriginAllowed = (
  header: string | string[] | undefined,
  allowed: readonly string[],
): boolean => {
  const origin = originOf(header);
  return origin !== null && allowed.includes(origin);
};
