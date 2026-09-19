import { z } from 'zod';

/**
 * Caddy's on-demand TLS check (ARCHITECTURE §3): before it asks Let's Encrypt
 * for a certificate for a hostname nobody configured, it calls
 * `GET /internal/domain-check?domain=…` and issues one only on a 200.
 */

/** 253 characters is the maximum length of a DNS name in presentation form. */
const MAX_DOMAIN_LENGTH = 253;
/**
 * Lower-case labels of letters, digits and hyphens, no leading or trailing
 * hyphen, at least two labels. Punycode (`xn--…`) passes as ASCII; a Unicode
 * hostname does not, which is correct — Caddy asks with the A-label.
 */
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const domainCheckQuerySchema = z.object({
  domain: z
    .string()
    .max(MAX_DOMAIN_LENGTH)
    // Caddy sends the ServerName as the client offered it. A trailing dot and
    // upper case are both legal there and never stored, so they are normalised
    // rather than refused.
    .transform((value) => value.trim().toLowerCase().replace(/\.$/, ''))
    .refine((value) => DOMAIN.test(value)),
});
export type DomainCheckQuery = z.infer<typeof domainCheckQuerySchema>;

/** Caddy reads the status code, not the body; the body is for an operator. */
export const domainCheckResultSchema = z.object({
  domain: z.string(),
});
export type DomainCheckResult = z.infer<typeof domainCheckResultSchema>;
