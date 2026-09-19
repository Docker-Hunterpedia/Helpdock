import type { FastifyHelmetOptions } from '@fastify/helmet';

/**
 * "Headers: HSTS, CSP, X-Content-Type-Options, Referrer-Policy" (REQUIREMENTS
 * §5.1), for the api's own responses.
 *
 * The api answers JSON. A JSON response has no scripts, styles, frames or
 * images of its own, so its policy is the strictest one there is — everything
 * denied. The admin SPA, the help center and the widget are served by other
 * controllers from M0-07, M5 and M4, and each brings the policy its own content
 * needs; none of them inherits this one.
 */

const ONE_YEAR_SECONDS = 31_536_000;

export interface SecurityHeaderOptions {
  /** `APP_URL`. HSTS is only meaningful, and only safe, on an https origin. */
  readonly appUrl: string;
}

/**
 * `APP_URL` is already validated as a URL at boot, so the parse cannot fail in
 * practice. It is guarded anyway because the failure modes are not symmetric:
 * answering "not https" costs an HSTS header, and throwing costs the server.
 */
export const isHttps = (appUrl: string): boolean => {
  try {
    return new URL(appUrl).protocol === 'https:';
  } catch {
    return false;
  }
};

export const securityHeaderOptions = ({ appUrl }: SecurityHeaderOptions): FastifyHelmetOptions => ({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
    },
  },
  // Sent only over https: a browser ignores the header on http, and a proxy
  // that terminates TLS elsewhere would otherwise pin a scheme this process
  // cannot serve.
  strictTransportSecurity: isHttps(appUrl)
    ? { maxAge: ONE_YEAR_SECONDS, includeSubDomains: true }
    : false,
  xContentTypeOptions: true,
  referrerPolicy: { policy: 'no-referrer' },
  // The api is not a browsing context; there is nothing to embed or to sniff a
  // cross-origin resource policy for beyond same-origin.
  crossOriginResourcePolicy: { policy: 'same-origin' },
  // Deprecated, and its legacy filter introduced vulnerabilities of its own.
  xXssProtection: false,
});
