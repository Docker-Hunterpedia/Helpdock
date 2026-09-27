import { useEffect, useRef, useState } from 'preact/hooks';
import type { ArticleSummary } from '../transport/types.js';
import { useWidget, useWidgetState } from '../ui/context.js';
import { Icon } from '../ui/icons.js';

const SEARCH_DEBOUNCE_MS = 250;

/**
 * `WidgetModesEN` column 4 (M4-05): help center only. With no query it lists
 * the brand's popular articles; a query goes to `searchArticles`, which filters
 * those same articles until M5-10 wires help center search behind it.
 */
export default function HelpCenter({
  onOpenArticle,
}: {
  onOpenArticle: (article: ArticleSummary) => void;
}) {
  const { controller, t, locale } = useWidget();
  const { config } = useWidgetState();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly ArticleSummary[] | null>(null);
  const trimmed = query.trim();
  const search = useRef<HTMLInputElement>(null);

  // This chunk arrives after the window opened, so it takes focus itself.
  useEffect(() => search.current?.focus(), []);

  useEffect(() => {
    if (!trimmed) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      controller.transport.searchArticles(trimmed, locale).then(
        (found) => live && setResults(found),
        () => live && setResults([]),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [trimmed, locale, controller]);

  if (!config) {
    return null;
  }
  const list = results ?? config.popular_articles;

  return (
    <>
      <search class="hd-search">
        <label for="hd-help-search" class="hd-visually-hidden">
          {t('articles.searchLabel')}
        </label>
        <div class="hd-search-field">
          <Icon name="search" />
          <input
            id="hd-help-search"
            ref={search}
            type="search"
            autocomplete="off"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      </search>
      <div class="hd-help">
        <div class="hd-caption" role="status">
          {results === null
            ? t('articles.popular')
            : results.length === 0
              ? t('articles.none')
              : t('articles.results', { count: results.length, query: trimmed })}
        </div>
        {list.length > 0 ? (
          <ul
            class="hd-article-list"
            aria-label={results ? t('articles.resultsLabel') : t('articles.popular')}
          >
            {list.map((article) => (
              <li key={article.id}>
                <a
                  class="hd-article-card"
                  href={article.url}
                  target="_blank"
                  rel="noopener"
                  onClick={(event) => {
                    if (!(event.metaKey || event.ctrlKey || event.shiftKey)) {
                      event.preventDefault();
                      onOpenArticle(article);
                    }
                  }}
                >
                  <Icon name="fileText" />
                  <span class="hd-grow hd-stack">
                    <span class="hd-article-title">{article.title}</span>
                    <span class="hd-article-excerpt">{article.excerpt}</span>
                  </span>
                  <Icon name="chevronEnd" size={16} />
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {config.help_center_url ? (
          <a class="hd-link" href={config.help_center_url} target="_blank" rel="noopener">
            {t('articles.openHelpCenter')}
            <Icon name="external" size={16} />
          </a>
        ) : null}
      </div>
    </>
  );
}
