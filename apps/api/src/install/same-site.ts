import { ForbiddenException } from '@nestjs/common';

/**
 * Refuses a wizard request that a browser made from somewhere else.
 *
 * Every other write in the api is authorised by a credential, and a
 * cross-site POST carries neither of Helpdock's cookies because both are
 * `SameSite=Lax` (`auth/session/cookies.ts`). The wizard's first step is the
 * one write that needs no credential at all, so nothing in that chain protects
 * it: a page on another origin could post it blind — it could not read the
 * answer, but it would not need to, because it chose the password.
 *
 * That matters most in exactly the setup the install guide recommends — the
 * host reachable only from inside, finished before anyone else can get to it —
 * because there a stranger's own browser cannot reach the api but the
 * operator's can.
 *
 * `Sec-Fetch-Site` is what closes it, and it is preferred to comparing
 * `Origin` against `APP_URL` because it needs no configuration to be right:
 * an install whose `APP_URL` does not match the host it is actually served on
 * would refuse its own wizard.
 *
 * | Value | Who sent it | Verdict |
 * |---|---|---|
 * | `same-origin` | the admin app this api serves | allowed |
 * | `none` | somebody typing the address, or a bookmark | allowed |
 * | `same-site` | another host under the same registrable domain | refused |
 * | `cross-site` | any other page | refused |
 * | absent | curl, a script, an old browser | allowed |
 *
 * A sibling subdomain is refused for the same reason the cookies carry no
 * `Domain`: `evil.example.com` is not this install.
 *
 * A client that sends no header is allowed through, which is not a hole: the
 * attack is somebody else's page using a browser as a confused deputy, and a
 * client with no browser behind it is simply the operator's own `curl`. Every
 * browser that has shipped since 2020 sends the header.
 */

const SEC_FETCH_SITE = 'sec-fetch-site';

const ALLOWED = new Set(['same-origin', 'none']);

export const isSameSiteRequest = (fetchSite: string | undefined): boolean =>
  fetchSite === undefined || ALLOWED.has(fetchSite);

export const assertSameSiteRequest = (headers: {
  readonly [SEC_FETCH_SITE]?: string | string[] | undefined;
}): void => {
  const header = headers[SEC_FETCH_SITE];
  const fetchSite = Array.isArray(header) ? header[0] : header;

  if (!isSameSiteRequest(fetchSite)) {
    throw new ForbiddenException('Setup can only be started from this install');
  }
};
