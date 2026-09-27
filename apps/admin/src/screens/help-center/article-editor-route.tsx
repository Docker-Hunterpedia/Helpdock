import { lazy, type ReactNode, Suspense } from 'react';
import { Navigate, useParams } from 'react-router';
import { helpCenterRoute } from '../../app/route-paths.js';

/**
 * The editor on a split route (ADR 0001): TipTap and ProseMirror are a
 * substantial dependency, and sign-in, the ticket list and the brand switcher
 * must not pay for them.
 */
const ArticleEditorPage = lazy(async () => ({
  default: (await import('./editor/article-editor-page.tsx')).ArticleEditorPage,
}));

export function ArticleEditorRoute(): ReactNode {
  const { articleId } = useParams();
  if (articleId === undefined) {
    return <Navigate to={helpCenterRoute('articles')} replace />;
  }
  return (
    <Suspense fallback={null}>
      <ArticleEditorPage articleId={articleId} />
    </Suspense>
  );
}
