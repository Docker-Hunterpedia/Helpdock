import type {
  HcArticleStatus,
  HcArticleSummary,
  HcStructure,
  HcVisibility,
} from '@helpdock/schemas';
import {
  Box,
  IconButton,
  InputAdornment,
  ListItemIcon,
  Menu,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { EllipsisVertical, FileText, Pencil, Search, Trash2, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { articleRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { EmptyState } from '../../shell/empty-state.tsx';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { visuallyHidden } from '../../ui/visually-hidden.js';
import {
  type ArticleFilters,
  breadcrumb,
  filterArticles,
  HC_LOCALES,
  type LanguageFilter,
  NO_FILTERS,
  nameIn,
  primaryVersion,
  titleOf,
} from './article-rows.js';
import { ArticleStatusBadge, LanguageChip, VisibilityLabel } from './badges.tsx';
import { NewArticleButton } from './new-article-button.tsx';
import { StructureTree } from './structure-tree.tsx';
import { formatStamp } from './time.js';
import { useHelpCenter, useSelectedSection, useStructureChange } from './use-help-center.js';

/**
 * The Articles tab of `Admin/HelpCenter` (M5-01): the Structure tree beside
 * the list of articles, with filters by title, status, visibility and missing
 * language, and the section the tree selected as a removable chip.
 */

/** The artboard's columns: the title takes what is left. */
const COLUMNS = [null, 188, 108, 100, 162, 44] as const;

export function ArticlesTab({ canManage }: { readonly canManage: boolean }): ReactNode {
  const t = useT();
  const { structure } = useHelpCenter();
  const [selected, setSelected] = useSelectedSection();

  if (structure.data === undefined) {
    return structure.isError ? (
      <Typography role="alert" sx={{ color: 'text.secondary' }}>
        {t('helpCenter:toast.failed')}
      </Typography>
    ) : null;
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '300px minmax(0, 1fr)' },
        gap: 6,
        alignItems: 'start',
      }}
    >
      <StructureTree
        structure={structure.data}
        canManage={canManage}
        selected={selected}
        onSelect={setSelected}
      />
      <ArticleList
        structure={structure.data}
        canManage={canManage}
        sectionId={selected}
        onClearSection={() => {
          setSelected(null);
        }}
      />
    </Box>
  );
}

function ArticleList({
  structure,
  canManage,
  sectionId,
  onClearSection,
}: {
  readonly structure: HcStructure;
  readonly canManage: boolean;
  readonly sectionId: string | null;
  onClearSection(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const { brand, api } = useHelpCenter();
  const [filters, setFilters] = useState<Omit<ArticleFilters, 'sectionId'>>(NO_FILTERS);
  const [menuFor, setMenuFor] = useState<{ article: HcArticleSummary; anchor: HTMLElement } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<HcArticleSummary | null>(null);

  const remove = useStructureChange(
    (article: HcArticleSummary) => api.deleteArticle(brand.id, article.id),
    (article) =>
      t('helpCenter:toast.deleted', {
        title: titleOf(article, locale, structure.defaultLocale),
      }),
  );

  const section = structure.sections.find((candidate) => candidate.id === sectionId);
  const rows = filterArticles(structure, { ...filters, sectionId: section?.id ?? null });
  const inSection =
    section === undefined
      ? structure.articles.length
      : structure.articles.filter((article) => article.sectionId === section.id).length;
  const sectionName = section === undefined ? null : nameIn(section.names, locale);

  const select = (
    label: string,
    value: string,
    options: readonly [string, string][],
    onChange: (value: string) => void,
  ) => (
    <Select
      size="small"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      inputProps={{ 'aria-label': label }}
      SelectDisplayProps={{ 'aria-label': label }}
      sx={{ height: 32, fontSize: 13 }}
    >
      {options.map(([key, text]) => (
        <MenuItem key={key} value={key}>
          {text}
        </MenuItem>
      ))}
    </Select>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <Box
        role="search"
        aria-label={t('helpCenter:filters.label')}
        sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
      >
        <TextField
          size="small"
          type="search"
          value={filters.q}
          placeholder={t('helpCenter:filters.search')}
          onChange={(event) => {
            setFilters({ ...filters, q: event.target.value });
          }}
          sx={{ inlineSize: 260 }}
          slotProps={{
            htmlInput: { 'aria-label': t('helpCenter:filters.search') },
            input: {
              sx: { height: 32, fontSize: 13 },
              startAdornment: (
                <InputAdornment position="start">
                  <Search size={14} aria-hidden="true" />
                </InputAdornment>
              ),
            },
          }}
        />
        {select(
          t('helpCenter:filters.status'),
          filters.status,
          [
            ['any', t('helpCenter:filters.anyStatus')],
            ...(['draft', 'published', 'scheduled', 'archived'] as const).map(
              (status): [string, string] => [status, t(`helpCenter:status.${status}`)],
            ),
          ],
          (value) => {
            setFilters({ ...filters, status: value as HcArticleStatus | 'any' });
          },
        )}
        {select(
          t('helpCenter:filters.visibility'),
          filters.visibility,
          [
            ['any', t('helpCenter:filters.anyVisibility')],
            ['public', t('helpCenter:visibility.public')],
            ['internal', t('helpCenter:visibility.internal')],
          ],
          (value) => {
            setFilters({ ...filters, visibility: value as HcVisibility | 'any' });
          },
        )}
        {select(
          t('helpCenter:filters.language'),
          filters.language,
          [
            ['any', t('helpCenter:filters.anyLanguage')],
            ['missing_ar', t('helpCenter:filters.missing_ar')],
            ['missing_en', t('helpCenter:filters.missing_en')],
          ],
          (value) => {
            setFilters({ ...filters, language: value as LanguageFilter });
          },
        )}
        {sectionName === null ? null : (
          <Box
            component="span"
            sx={{
              height: 28,
              paddingInlineStart: '10px',
              paddingInlineEnd: 1,
              borderRadius: '6px',
              backgroundColor: tokens['bg.muted'],
              border: `1px solid ${tokens['border.default']}`,
              fontSize: 12,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
            }}
          >
            {t('helpCenter:filters.section', { name: sectionName })}
            <IconButton
              size="small"
              aria-label={t('helpCenter:filters.clearSection')}
              onClick={onClearSection}
              sx={{ width: 20, height: 20 }}
            >
              <X size={14} aria-hidden="true" />
            </IconButton>
          </Box>
        )}
        <Typography
          variant="caption"
          aria-live="polite"
          sx={{ marginInlineStart: 'auto', color: 'text.secondary', fontWeight: 400 }}
        >
          {t('helpCenter:filters.count', { shown: rows.length, total: structure.articles.length })}
        </Typography>
      </Box>

      {inSection === 0 ? (
        <EmptyState
          icon={FileText}
          heading={t('helpCenter:empty.heading')}
          body={t('helpCenter:empty.body')}
          action={canManage ? <NewArticleButton variant="outlined" /> : undefined}
        />
      ) : (
        <Box
          component="section"
          aria-label={t('helpCenter:list.label')}
          sx={{
            borderRadius: '10px',
            backgroundColor: tokens['bg.surface'],
            border: `1px solid ${tokens['border.default']}`,
            overflowX: 'auto',
          }}
        >
          <Box
            component="table"
            aria-label={
              sectionName === null
                ? t('helpCenter:list.all')
                : t('helpCenter:list.inSection', { name: sectionName })
            }
            sx={{
              minWidth: 720,
              width: '100%',
              borderCollapse: 'collapse',
              tableLayout: 'fixed',
              fontSize: 13,
              '& th': {
                height: 36,
                paddingInline: '6px',
                backgroundColor: tokens['bg.muted'],
                fontSize: 12,
                fontWeight: 500,
                color: 'text.secondary',
                textAlign: 'start',
              },
              '& td': {
                height: 52,
                paddingInline: '6px',
                borderBlockStart: `1px solid ${tokens['bg.muted']}`,
                verticalAlign: 'middle',
              },
              '& th:first-of-type, & td:first-of-type': { paddingInlineStart: 4 },
              '& th:last-of-type, & td:last-of-type': { paddingInlineEnd: 4 },
            }}
          >
            <colgroup>
              {COLUMNS.map((width, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the columns are a fixed list.
                <col key={index} style={width === null ? undefined : { width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t('helpCenter:list.columns.article')}</th>
                <th scope="col">{t('helpCenter:list.columns.status')}</th>
                <th scope="col">{t('helpCenter:list.columns.visibility')}</th>
                <th scope="col">{t('helpCenter:list.columns.languages')}</th>
                <th scope="col">{t('helpCenter:list.columns.updated')}</th>
                <th scope="col">
                  <Box component="span" sx={visuallyHidden}>
                    {t('helpCenter:list.columns.actions')}
                  </Box>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                      {t('helpCenter:list.noMatch')}
                    </Typography>
                  </td>
                </tr>
              ) : (
                rows.map((article) => {
                  const primary = primaryVersion(article, structure.defaultLocale);
                  const title = titleOf(article, locale, structure.defaultLocale);
                  return (
                    <tr key={article.id}>
                      <td>
                        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                          <Box
                            component={Link}
                            to={articleRoute(article.id)}
                            sx={{
                              color: 'text.primary',
                              fontWeight: 500,
                              fontSize: 14,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              textDecoration: 'none',
                              '&:hover': { textDecoration: 'underline' },
                            }}
                          >
                            {title}
                          </Box>
                          <Typography
                            variant="caption"
                            sx={{ color: 'text.secondary', fontWeight: 400 }}
                          >
                            {breadcrumb(structure, article.sectionId, locale)}
                          </Typography>
                        </Box>
                      </td>
                      <td>
                        {primary === undefined ? null : (
                          <ArticleStatusBadge
                            status={primary.status}
                            scheduledLabel={
                              primary.scheduledAt === null
                                ? undefined
                                : t('helpCenter:status.scheduledAt', {
                                    when: formatStamp(
                                      primary.scheduledAt,
                                      locale,
                                      structure.timezone,
                                    ),
                                  })
                            }
                          />
                        )}
                      </td>
                      <td>
                        {primary === undefined ? null : (
                          <VisibilityLabel visibility={primary.visibility} />
                        )}
                      </td>
                      <td>
                        <Box sx={{ display: 'flex', gap: 1 }}>
                          {HC_LOCALES.map((candidate) => (
                            <LanguageChip
                              key={candidate}
                              locale={candidate}
                              present={article.versions.some(
                                (version) => version.locale === candidate,
                              )}
                            />
                          ))}
                        </Box>
                      </td>
                      <td>
                        {primary === undefined ? null : (
                          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                            <Typography variant="mono" component="span">
                              {formatStamp(primary.updatedAt, locale, structure.timezone)}
                            </Typography>
                            <Typography
                              variant="caption"
                              sx={{ color: 'text.secondary', fontWeight: 400 }}
                            >
                              {primary.updatedByName ?? ''}
                            </Typography>
                          </Box>
                        )}
                      </td>
                      <td>
                        <IconButton
                          size="small"
                          aria-label={t('helpCenter:list.actions', { title })}
                          aria-haspopup="menu"
                          onClick={(event) => {
                            setMenuFor({ article, anchor: event.currentTarget });
                          }}
                          sx={{ width: 28, height: 28 }}
                        >
                          <EllipsisVertical size={16} aria-hidden="true" />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </Box>
        </Box>
      )}

      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
        {t('helpCenter:list.footnote')}
      </Typography>

      <Menu
        anchorEl={menuFor?.anchor ?? null}
        open={menuFor !== null}
        onClose={() => {
          setMenuFor(null);
        }}
      >
        <MenuItem component={Link} to={articleRoute(menuFor?.article.id ?? '')}>
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t(canManage ? 'helpCenter:list.menu.edit' : 'helpCenter:list.menu.open')}
        </MenuItem>
        {canManage ? (
          <MenuItem
            onClick={() => {
              setDeleting(menuFor?.article ?? null);
              setMenuFor(null);
            }}
            sx={{ color: tokens['status.danger.text'] }}
          >
            <ListItemIcon sx={{ color: 'inherit' }}>
              <Trash2 size={16} aria-hidden="true" />
            </ListItemIcon>
            {t('helpCenter:list.menu.delete')}
          </MenuItem>
        ) : null}
      </Menu>

      <ConfirmDialog
        open={deleting !== null}
        destructive
        busy={remove.isPending}
        title={t('helpCenter:list.confirm.title', {
          title: deleting === null ? '' : titleOf(deleting, locale, structure.defaultLocale),
        })}
        body={t('helpCenter:list.confirm.body')}
        confirmLabel={t('helpCenter:list.confirm.submit')}
        onClose={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
          setDeleting(null);
        }}
      />
    </Box>
  );
}
