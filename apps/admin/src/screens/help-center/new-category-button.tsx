import { Button } from '@mui/material';
import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { nameIn } from './article-rows.js';
import { NamesDialog } from './names-dialog.tsx';
import { useHelpCenter, useReaderLocale, useStructureChange } from './use-help-center.js';

/**
 * "New category" for an empty help center: the first category, named in the
 * same dialog the Structure card uses once there is a tree to add to.
 */
export function NewCategoryButton(): ReactNode {
  const t = useT();
  const locale = useReaderLocale();
  const { brand, api } = useHelpCenter();
  const [naming, setNaming] = useState(false);

  const create = useStructureChange(
    (names: { en: string; ar: string }) => api.createCategory(brand.id, { names }),
    (names) => t('helpCenter:toast.categoryCreated', { name: nameIn(names, locale) }),
  );

  return (
    <>
      <Button
        variant="contained"
        startIcon={<Plus size={16} aria-hidden="true" />}
        onClick={() => {
          setNaming(true);
        }}
      >
        {t('helpCenter:emptyCategories.action')}
      </Button>
      <NamesDialog
        open={naming}
        title={t('helpCenter:tree.dialog.category')}
        body={t('helpCenter:tree.dialog.body')}
        busy={create.isPending}
        onClose={() => {
          setNaming(false);
        }}
        onSubmit={(names) => {
          create.mutate(names);
          setNaming(false);
        }}
      />
    </>
  );
}
