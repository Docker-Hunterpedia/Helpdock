/**
 * A crawl's include and exclude patterns (the add-source dialog: "One per
 * line. Empty includes everything. Exclude wins over include."). A pattern is
 * matched against a URL's path and query, `*` standing for any run of
 * characters: `/docs/*` keeps everything under `/docs/`, `*\/changelog` drops
 * every changelog.
 */

const toRegex = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );

export interface UrlFilter {
  /** `included`, or which list kept it out. */
  verdict(url: string): 'included' | 'excluded' | 'not-included';
}

export const urlFilter = (include: readonly string[], exclude: readonly string[]): UrlFilter => {
  const includes = include.map(toRegex);
  const excludes = exclude.map(toRegex);
  return {
    verdict: (url) => {
      const { pathname, search } = new URL(url);
      const target = `${pathname}${search}`;
      if (excludes.some((regex) => regex.test(target))) {
        return 'excluded';
      }
      if (includes.length > 0 && !includes.some((regex) => regex.test(target))) {
        return 'not-included';
      }
      return 'included';
    },
  };
};
