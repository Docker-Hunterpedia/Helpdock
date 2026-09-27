import type { HcStructure } from '@helpdock/schemas';
import { Box, Button, IconButton, Typography } from '@mui/material';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  GripVertical,
  Plus,
} from 'lucide-react';
import { Fragment, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { articleRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { moveBy, moveTo } from '../admin/ticketing/reorder.js';
import {
  articlesOf,
  countArticles,
  nameIn,
  orderedCategories,
  sectionsOf,
  titleOf,
} from './article-rows.js';
import { NamesDialog } from './names-dialog.tsx';
import { useHelpCenter, useReaderLocale, useStructureChange } from './use-help-center.js';

/**
 * The Structure card of `Admin/HelpCenter` (DESIGN §6.3 ContentTree): the
 * categories, their sections and each section's articles, in the order the
 * help center shows them.
 *
 * Every row has a drag handle that is a real button: drag it, or focus it and
 * press ArrowUp or ArrowDown, which moves the row within its parent. Dropping
 * an article on an article or a section of another section moves it there,
 * and dropping a section on another category's section does the same. Each
 * move sends the parent's whole order back (`POST …/reorder`), the one shape
 * the api accepts.
 *
 * Selecting a section filters the list beside it.
 */

type Kind = 'categories' | 'sections' | 'articles';

interface Dragged {
  readonly kind: Kind;
  readonly id: string;
}

export function StructureTree({
  structure,
  canManage,
  selected,
  onSelect,
}: {
  readonly structure: HcStructure;
  readonly canManage: boolean;
  readonly selected: string | null;
  onSelect(sectionId: string | null): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const locale = useReaderLocale();
  const { brand, api } = useHelpCenter();
  const counts = countArticles(structure);
  const categories = orderedCategories(structure);

  const selectedCategory = structure.sections.find(
    (section) => section.id === selected,
  )?.categoryId;
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        [selectedCategory ?? categories[0]?.id, selected].filter(
          (value): value is string => value !== undefined && value !== null,
        ),
      ),
  );
  const [dragging, setDragging] = useState<Dragged | null>(null);
  const [naming, setNaming] = useState<
    { kind: 'category' } | { kind: 'section'; categoryId: string } | null
  >(null);

  const reorder = useStructureChange(
    ({ kind, parentId, ids }: { kind: Kind; parentId: string | null; ids: readonly string[] }) =>
      api.reorder(brand.id, kind, { parentId, ids: [...ids] }),
    () => t('helpCenter:toast.reordered'),
  );
  const createCategory = useStructureChange(
    (names: { en: string; ar: string }) => api.createCategory(brand.id, { names }),
    (names) => t('helpCenter:toast.categoryCreated', { name: nameIn(names, locale) }),
  );
  const createSection = useStructureChange(
    ({ categoryId, names }: { categoryId: string; names: { en: string; ar: string } }) =>
      api.createSection(brand.id, { categoryId, names }),
    ({ names }) => t('helpCenter:toast.sectionCreated', { name: nameIn(names, locale) }),
  );
  const busy = reorder.isPending || createCategory.isPending || createSection.isPending;

  const toggle = (id: string): void => {
    const next = new Set(open);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setOpen(next);
  };

  const send = (
    kind: Kind,
    parentId: string | null,
    before: readonly string[],
    after: readonly string[],
  ) => {
    if (before !== after) {
      reorder.mutate({ kind, parentId, ids: after });
    }
  };

  /** Where a drop of the dragged row on `target` lands: its parent's order with it inserted there. */
  const drop = (target: {
    kind: Kind;
    id: string;
    parentId: string | null;
    siblings: readonly string[];
  }) => {
    if (dragging === null) {
      return;
    }
    const { kind, id } = dragging;
    setDragging(null);
    if (kind === target.kind && id !== target.id) {
      const inside = target.siblings.includes(id);
      const order = inside ? target.siblings : [...target.siblings, id];
      send(
        kind,
        target.parentId,
        inside ? target.siblings : [],
        moveTo(order, id, target.siblings.indexOf(target.id)),
      );
      return;
    }
    // An article dropped on a section row, or a section on a category row,
    // joins the end of it.
    const parentKind: Kind | null =
      kind === 'articles' ? 'sections' : kind === 'sections' ? 'categories' : null;
    if (parentKind === target.kind) {
      const children =
        kind === 'articles'
          ? articlesOf(structure, target.id).map((article) => article.id)
          : sectionsOf(structure, target.id).map((section) => section.id);
      if (!children.includes(id)) {
        send(kind, target.id, [], [...children, id]);
      }
    }
  };

  const handle = (
    kind: Kind,
    id: string,
    name: string,
    parentId: string | null,
    siblings: readonly string[],
  ): ReactNode =>
    canManage ? (
      <IconButton
        size="small"
        aria-label={t('helpCenter:tree.move', { name })}
        draggable
        disabled={busy}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          setDragging({ kind, id });
        }}
        onDragEnd={() => {
          setDragging(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            send(kind, parentId, siblings, moveBy(siblings, id, event.key === 'ArrowUp' ? -1 : 1));
          }
        }}
        sx={{
          width: 24,
          height: 28,
          cursor: 'grab',
          color: tokens['text.secondary'],
          flexShrink: 0,
        }}
      >
        <GripVertical size={16} aria-hidden="true" />
      </IconButton>
    ) : null;

  const row = (
    level: 1 | 2 | 3,
    {
      kind,
      id,
      parentId,
      siblings,
      isSelected = false,
      moving = false,
    }: {
      kind: Kind;
      id: string;
      parentId: string | null;
      siblings: readonly string[];
      isSelected?: boolean;
      moving?: boolean;
    },
  ) => ({
    role: 'treeitem',
    'aria-level': level,
    ...(isSelected ? { 'aria-selected': true } : {}),
    onDragOver: (event: React.DragEvent) => {
      if (dragging !== null) {
        event.preventDefault();
      }
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      drop({ kind, id, parentId, siblings });
    },
    sx: {
      display: 'flex',
      alignItems: 'center',
      gap: 1,
      height: 32,
      paddingInlineStart: `${(level - 1) * 20}px`,
      paddingInlineEnd: 2,
      borderRadius: '4px',
      borderInlineStart: `3px solid ${isSelected ? tokens['action.primary'] : 'transparent'}`,
      backgroundColor: isSelected
        ? tokens['action.primary.tint']
        : moving
          ? tokens['bg.canvas']
          : 'transparent',
      outline: moving ? `1px dashed ${tokens['border.strong']}` : undefined,
      outlineOffset: '-1px',
    },
  });

  const count = (value: number | undefined) => (
    <Typography
      variant="mono"
      component="span"
      sx={{ marginInlineStart: 'auto', color: 'text.secondary' }}
    >
      {value ?? 0}
    </Typography>
  );

  const categoryIds = categories.map((category) => category.id);

  return (
    <Box
      component="section"
      aria-labelledby="hc-tree-heading"
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          paddingBlock: '14px 10px',
          paddingInline: 4,
          borderBlockEnd: `1px solid ${tokens['bg.muted']}`,
        }}
      >
        <Typography variant="h3" component="h2" id="hc-tree-heading" sx={{ flexGrow: 1 }}>
          {t('helpCenter:tree.heading')}
        </Typography>
        {canManage ? (
          <Button
            size="small"
            variant="text"
            startIcon={<Plus size={16} aria-hidden="true" />}
            onClick={() => {
              setNaming({ kind: 'category' });
            }}
          >
            {t('helpCenter:tree.addCategory')}
          </Button>
        ) : null}
      </Box>

      <Box
        component="ul"
        role="tree"
        aria-labelledby="hc-tree-heading"
        sx={{
          margin: 0,
          padding: 2,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
        }}
      >
        {categories.map((category) => {
          const categoryName = nameIn(category.names, locale);
          const expanded = open.has(category.id);
          const sections = sectionsOf(structure, category.id);
          const sectionIds = sections.map((section) => section.id);
          return (
            <Fragment key={category.id}>
              <Box
                component="li"
                {...row(1, {
                  kind: 'categories',
                  id: category.id,
                  parentId: null,
                  siblings: categoryIds,
                })}
                aria-expanded={expanded}
              >
                {handle('categories', category.id, categoryName, null, categoryIds)}
                <ExpandButton
                  expanded={expanded}
                  label={categoryName}
                  onClick={() => {
                    toggle(category.id);
                  }}
                />
                <Box
                  component="span"
                  aria-hidden="true"
                  sx={{ display: 'inline-flex', color: 'text.secondary' }}
                >
                  {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                </Box>
                <TreeLabel
                  strong
                  onClick={() => {
                    toggle(category.id);
                  }}
                >
                  {categoryName}
                </TreeLabel>
                {count(counts.byCategory.get(category.id))}
              </Box>
              {expanded ? (
                <>
                  {sections.map((section) => {
                    const sectionName = nameIn(section.names, locale);
                    const sectionOpen = open.has(section.id);
                    const articles = articlesOf(structure, section.id);
                    const articleIds = articles.map((article) => article.id);
                    return (
                      <Fragment key={section.id}>
                        <Box
                          component="li"
                          {...row(2, {
                            kind: 'sections',
                            id: section.id,
                            parentId: category.id,
                            siblings: sectionIds,
                            isSelected: selected === section.id,
                          })}
                          aria-expanded={sectionOpen}
                        >
                          {handle('sections', section.id, sectionName, category.id, sectionIds)}
                          <ExpandButton
                            expanded={sectionOpen}
                            label={sectionName}
                            onClick={() => {
                              toggle(section.id);
                            }}
                          />
                          <TreeLabel
                            strong
                            current={selected === section.id}
                            onClick={() => {
                              onSelect(selected === section.id ? null : section.id);
                            }}
                          >
                            {sectionName}
                          </TreeLabel>
                          {count(counts.bySection.get(section.id))}
                        </Box>
                        {sectionOpen
                          ? articles.map((article) => {
                              const title = titleOf(article, locale, structure.defaultLocale);
                              return (
                                <Box
                                  component="li"
                                  key={article.id}
                                  {...row(3, {
                                    kind: 'articles',
                                    id: article.id,
                                    parentId: section.id,
                                    siblings: articleIds,
                                    moving: dragging?.id === article.id,
                                  })}
                                >
                                  {handle('articles', article.id, title, section.id, articleIds)}
                                  <Box
                                    component="span"
                                    aria-hidden="true"
                                    sx={{
                                      display: 'inline-flex',
                                      color: 'text.secondary',
                                      marginInlineStart: '14px',
                                    }}
                                  >
                                    <FileText size={14} />
                                  </Box>
                                  <Box
                                    component={Link}
                                    to={articleRoute(article.id)}
                                    sx={{
                                      color: 'text.primary',
                                      fontSize: 13,
                                      whiteSpace: 'nowrap',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      minWidth: 0,
                                      textDecoration: 'none',
                                      '&:hover': { textDecoration: 'underline' },
                                    }}
                                  >
                                    {title}
                                  </Box>
                                </Box>
                              );
                            })
                          : null}
                      </Fragment>
                    );
                  })}
                  {canManage ? (
                    <Box
                      component="li"
                      role="treeitem"
                      aria-level={2}
                      sx={{ paddingInlineStart: '20px' }}
                    >
                      <Button
                        size="small"
                        variant="text"
                        startIcon={<Plus size={16} aria-hidden="true" />}
                        onClick={() => {
                          setNaming({ kind: 'section', categoryId: category.id });
                        }}
                      >
                        {t('helpCenter:tree.addSection')}
                      </Button>
                    </Box>
                  ) : null}
                </>
              ) : null}
            </Fragment>
          );
        })}
      </Box>

      <Typography
        variant="caption"
        sx={{
          marginBlockStart: 'auto',
          paddingBlock: '10px',
          paddingInline: 4,
          borderBlockStart: `1px solid ${tokens['bg.muted']}`,
          color: 'text.secondary',
          fontWeight: 400,
        }}
      >
        {t(canManage ? 'helpCenter:tree.footnote' : 'helpCenter:tree.readOnly')}
      </Typography>

      <NamesDialog
        open={naming !== null}
        title={t(
          naming?.kind === 'section'
            ? 'helpCenter:tree.dialog.section'
            : 'helpCenter:tree.dialog.category',
        )}
        body={t('helpCenter:tree.dialog.body')}
        busy={busy}
        onClose={() => {
          setNaming(null);
        }}
        onSubmit={(names) => {
          if (naming?.kind === 'section') {
            createSection.mutate({ categoryId: naming.categoryId, names });
          } else {
            createCategory.mutate(names);
          }
          setNaming(null);
        }}
      />
    </Box>
  );
}

function ExpandButton({
  expanded,
  label,
  onClick,
}: {
  readonly expanded: boolean;
  readonly label: string;
  onClick(): void;
}): ReactNode {
  const t = useT();
  return (
    <IconButton
      size="small"
      aria-label={t(expanded ? 'helpCenter:tree.collapse' : 'helpCenter:tree.expand', {
        name: label,
      })}
      onClick={onClick}
      sx={{ width: 20, height: 20, color: 'text.secondary', flexShrink: 0 }}
    >
      {expanded ? (
        <ChevronDown size={14} aria-hidden="true" />
      ) : (
        <Box
          component="span"
          sx={{ display: 'inline-flex', '[dir="rtl"] &': { transform: 'scaleX(-1)' } }}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </Box>
      )}
    </IconButton>
  );
}

function TreeLabel({
  children,
  strong = false,
  current = false,
  onClick,
}: {
  readonly children: ReactNode;
  readonly strong?: boolean;
  readonly current?: boolean;
  onClick(): void;
}): ReactNode {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      aria-pressed={current || undefined}
      sx={{
        border: 0,
        padding: 0,
        background: 'transparent',
        color: 'text.primary',
        font: 'inherit',
        fontSize: 13,
        fontWeight: strong ? 500 : 400,
        textAlign: 'start',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
        cursor: 'pointer',
        '&:hover': { textDecoration: 'underline' },
      }}
    >
      {children}
    </Box>
  );
}
