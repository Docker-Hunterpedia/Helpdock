import { Button } from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '../../app/i18n.js';
import { articleRoute } from '../../app/route-paths.js';
import { articlesOf, orderedCategories, sectionsOf } from './article-rows.js';
import {
  useHelpCenter,
  useHelpCenterReport,
  useReaderLocale,
  useSelectedSection,
} from './use-help-center.js';

/**
 * "New article": a draft in the section the tree has selected — or the first
 * section there is — in the reader's language, opened in the editor. It stays
 * a draft until somebody publishes it (the empty state's promise).
 */
export function NewArticleButton({
  variant = 'contained',
}: {
  readonly variant?: 'contained' | 'outlined';
}): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const locale = useReaderLocale();
  const report = useHelpCenterReport();
  const { brand, api, structure } = useHelpCenter();
  const [selected] = useSelectedSection();

  const data = structure.data;
  const firstSection =
    data === undefined
      ? undefined
      : orderedCategories(data)
          .flatMap((category) => sectionsOf(data, category.id))
          .at(0)?.id;
  const sectionId = selected ?? firstSection;

  const create = useMutation({
    mutationFn: (id: string) =>
      api.createArticle(brand.id, {
        sectionId: id,
        locale,
        title: t('helpCenter:newArticle.untitled', {
          n: (data === undefined ? 0 : articlesOf(data, id).length) + 1,
        }),
      }),
    onSuccess: (article) => {
      void navigate(articleRoute(article.id));
    },
    onError: report,
  });

  return (
    <Button
      variant={variant}
      startIcon={<Plus size={16} aria-hidden="true" />}
      disabled={sectionId === undefined || create.isPending}
      onClick={() => {
        if (sectionId !== undefined) {
          create.mutate(sectionId);
        }
      }}
    >
      {t('helpCenter:newArticle.label')}
    </Button>
  );
}
