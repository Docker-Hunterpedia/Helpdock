/**
 * `robots.txt` as RFC 9309 reads it, for the crawler (DOMAIN-RULES §13:
 * "Crawler respects `robots.txt`").
 *
 * The group for {@link CRAWLER_USER_AGENT} applies when there is one, else the
 * `*` group. Within it the longest matching rule wins, and `Allow` wins a tie;
 * `*` matches any run of characters and a trailing `$` anchors the end. A
 * `Crawl-delay` is honoured as a lower bound on the time between requests,
 * and `Sitemap` lines are collected for a crawl that starts from the site.
 *
 * A `robots.txt` that is missing (4xx) allows everything; one that cannot be
 * read (5xx, network failure) disallows everything, as the RFC asks — the
 * caller decides which by passing {@link DISALLOW_ALL}.
 */

export const CRAWLER_USER_AGENT = 'HelpdockBot';

interface Rule {
  readonly allow: boolean;
  readonly pattern: string;
  readonly regex: RegExp;
}

export interface RobotsRules {
  isAllowed(path: string): boolean;
  /** Seconds, when the group asked for one. */
  readonly crawlDelay: number | undefined;
  readonly sitemaps: readonly string[];
  /** How many rules apply to this crawler, for the sync log. */
  readonly ruleCount: number;
}

const toRegex = (pattern: string): RegExp => {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
};

const rulesFrom = (rules: readonly Rule[], crawlDelay: number | undefined, sitemaps: string[]) => ({
  crawlDelay,
  sitemaps,
  ruleCount: rules.length,
  isAllowed: (path: string): boolean => {
    let best: Rule | undefined;
    for (const rule of rules) {
      if (!rule.regex.test(path)) {
        continue;
      }
      if (
        best === undefined ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow)
      ) {
        best = rule;
      }
    }
    return best?.allow ?? true;
  },
});

export const ALLOW_ALL: RobotsRules = rulesFrom([], undefined, []);
export const DISALLOW_ALL: RobotsRules = rulesFrom(
  [{ allow: false, pattern: '/', regex: /^\// }],
  undefined,
  [],
);

interface Group {
  readonly agents: string[];
  readonly rules: Rule[];
  crawlDelay: number | undefined;
}

export const parseRobots = (text: string, userAgent = CRAWLER_USER_AGENT): RobotsRules => {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) {
      continue;
    }
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: undefined };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === undefined) {
      continue;
    }
    if ((field === 'allow' || field === 'disallow') && value !== '') {
      current.rules.push({ allow: field === 'allow', pattern: value, regex: toRegex(value) });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelay = seconds;
      }
    }
  }

  const agent = userAgent.toLowerCase();
  const own = groups.filter((group) => group.agents.some((name) => agent.startsWith(name)));
  const chosen = own.length > 0 ? own : groups.filter((group) => group.agents.includes('*'));
  return rulesFrom(
    chosen.flatMap((group) => group.rules),
    chosen.find((group) => group.crawlDelay !== undefined)?.crawlDelay,
    sitemaps,
  );
};
