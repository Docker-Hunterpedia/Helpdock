/**
 * Which staff account a Google or GitHub sign-in is (1.0.1, ADR 0051).
 *
 * The provider account is bound by its stable subject in
 * `user_oauth_identities`, and a bound subject signs in whatever address the
 * provider reports today. The address is used for one thing only: the first
 * link, and only where the provider controls the address. A provider that
 * merely says an address was verified once does not: GitHub keeps an address
 * "verified" after its owner loses the mailbox, and a consumer Google account
 * can be registered on anybody's address. Those link from inside a session.
 *
 * This is the same rule #219 gave SSO identities.
 */

/** Addresses Google issues itself, so a consumer account on one is Google's to vouch for. */
const GOOGLE_MAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/**
 * Whether Google controls `email`: a managed Workspace account, whose `hd`
 * claim is the address's own domain, or a Gmail address. Never an unverified
 * address.
 */
export const googleIsAuthoritative = ({
  email,
  emailVerified,
  hostedDomain,
}: {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly hostedDomain: string | undefined;
}): boolean => {
  if (!emailVerified) {
    return false;
  }
  const domain = domainOf(email);
  return hostedDomain?.toLowerCase() === domain || GOOGLE_MAIL_DOMAINS.has(domain);
};

export type OauthSignInDecision =
  | { readonly kind: 'sign-in'; readonly userId: string; readonly link: boolean }
  | {
      readonly kind: 'refuse';
      readonly code: 'oauth-link-required' | 'oauth-identity-conflict' | 'no-account';
      /** Who the audit row is about; null when the answer must name nobody. */
      readonly userId: string | null;
      readonly reason: 'link-required' | 'identity-conflict' | 'unknown-account';
    };

/**
 * `linkedUserId` is the account the subject is bound to, if any. `emailMatch`
 * is the account holding the reported address, and whether it is already bound
 * to an account of this provider.
 *
 * A provider that does not control the address gets `oauth-link-required`
 * whether or not anybody holds it, so the answer is no address oracle.
 */
export const decideOauthSignIn = ({
  linkedUserId,
  authoritative,
  emailMatch,
}: {
  readonly linkedUserId: string | undefined;
  readonly authoritative: boolean;
  readonly emailMatch:
    | { readonly userId: string; readonly hasProviderIdentity: boolean }
    | undefined;
}): OauthSignInDecision => {
  if (linkedUserId !== undefined) {
    return { kind: 'sign-in', userId: linkedUserId, link: false };
  }
  if (!authoritative) {
    return { kind: 'refuse', code: 'oauth-link-required', userId: null, reason: 'link-required' };
  }
  if (emailMatch === undefined) {
    return { kind: 'refuse', code: 'no-account', userId: null, reason: 'unknown-account' };
  }
  if (emailMatch.hasProviderIdentity) {
    return {
      kind: 'refuse',
      code: 'oauth-identity-conflict',
      userId: emailMatch.userId,
      reason: 'identity-conflict',
    };
  }
  return { kind: 'sign-in', userId: emailMatch.userId, link: true };
};
