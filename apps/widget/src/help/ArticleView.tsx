import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDate } from '../format.js';
import type { ArticleDetail, ArticleSummary } from '../transport/types.js';
import { useWidget } from '../ui/context.js';
import { Icon } from '../ui/icons.js';
import { sanitizeArticle } from './sanitize.js';

/**
 * `WidgetModesEN` column 5: one article inside the window. The header (back,
 * title, section) is drawn by the window; this is the body and the footer link.
 */
export default function ArticleView({ article }: { article: ArticleSummary }) {
  const { controller, t, locale } = useWidget();
  const [detail, setDetail] = useState<ArticleDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setFailed(false);
    controller.transport.getArticle(article.id, locale).then(
      (value) => live && setDetail(value),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [article.id, locale, controller]);

  useEffect(() => {
    const element = body.current;
    if (element && detail) {
      element.replaceChildren(sanitizeArticle(detail.body_html, element.ownerDocument));
      heading.current?.focus();
    }
  }, [detail]);

  return (
    <>
      <article class="hd-article" aria-busy={!detail && !failed}>
        <h3 ref={heading} class="hd-h2" tabIndex={-1}>
          {article.title}
        </h3>
        {detail ? (
          <div class="hd-caption">
            {t('articles.updated', { date: formatDate(detail.updated_at, locale) })} ·{' '}
            {t('articles.readingTime', { count: detail.reading_minutes })}
          </div>
        ) : null}
        {failed ? (
          <p class="hd-alert hd-alert-danger" role="alert">
            <Icon name="alert" size={16} />
            <span>{t('articles.loadFailed')}</span>
          </p>
        ) : null}
        <div class="hd-article-body" ref={body} />
      </article>
      {article.url ? (
        <div class="hd-article-footer">
          <a class="hd-link" href={article.url} target="_blank" rel="noopener">
            {t('articles.openInHelpCenter')}
            <Icon name="external" size={16} />
          </a>
        </div>
      ) : null}
    </>
  );
}
