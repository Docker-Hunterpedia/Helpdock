import { HC_FEATURED_MAX, type HcHomeLayout, type HcStructure } from '@helpdock/schemas';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import { GripVertical, Plus, X } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { SectionCard } from '../../admin/channels/section-card.tsx';
import { useHelpCenter, useReaderLocale } from '../use-help-center.js';
import { moved } from './site-draft.js';
import { useSiteSave } from './use-site.js';

/**
 * "Home page" (M5-06, `Admin/HelpCenter-Settings`): what the front page shows
 * top to bottom. Search is always there; category cards, the featured list
 * (up to six, in order, reordered by dragging or with ArrowUp / ArrowDown on
 * a handle, as the Structure tree does) and the popular list can be turned off.
 */
export function HomeCard({
  home,
  structure,
  canManage,
}: {
  readonly home: HcHomeLayout;
  readonly structure: HcStructure | undefined;
  readonly canManage: boolean;
}): ReactNode {
  const t = useT();
  const id = useId();
  const tokens = useSemanticTokens();
  const reader = useReaderLocale();
  const { api } = useHelpCenter();
  const [draft, setDraft] = useState<HcHomeLayout>(home);
  const [adding, setAdding] = useState('');
  useEffect(() => {
    setDraft(home);
  }, [home]);

  const save = useSiteSave(api.saveHome.bind(api), (site, result: HcHomeLayout) => ({
    ...site,
    home: result,
  }));

  const titleOf = (articleId: string): string => {
    const article = structure?.articles.find((candidate) => candidate.id === articleId);
    const version =
      article?.versions.find((candidate) => candidate.locale === reader) ?? article?.versions[0];
    return version?.title ?? articleId;
  };
  const choices = (structure?.articles ?? []).filter(
    (article) =>
      !draft.featuredArticleIds.includes(article.id) &&
      article.versions.some((version) => version.status === 'published'),
  );

  const toggle = (key: 'categories' | 'featured' | 'popular', label: string, hint: string) => (
    <FormControlLabel
      control={
        <Checkbox
          size="small"
          checked={draft[key]}
          disabled={!canManage}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })}
        />
      }
      sx={{ alignItems: 'flex-start', marginInlineStart: 0, gap: 1 }}
      label={<Label text={label} hint={hint} />}
    />
  );

  const move = (index: number, delta: -1 | 1): void => {
    setDraft({ ...draft, featuredArticleIds: moved(draft.featuredArticleIds, index, delta) });
  };

  return (
    <SectionCard
      id={`${id}-home`}
      heading={t('helpCenter:site.home.heading')}
      caption={t('helpCenter:site.home.caption')}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate(draft);
      }}
      {...(canManage
        ? {
            footer: (
              <>
                <Button variant="text" disabled={save.isPending} onClick={() => setDraft(home)}>
                  {t('helpCenter:settings.discard')}
                </Button>
                <Button type="submit" variant="contained" disabled={save.isPending}>
                  {t('helpCenter:settings.save')}
                </Button>
              </>
            ),
          }
        : {})}
    >
      <FormControlLabel
        control={<Checkbox size="small" checked disabled />}
        sx={{ alignItems: 'flex-start', marginInlineStart: 0, gap: 1 }}
        label={
          <Label
            text={t('helpCenter:site.home.search')}
            hint={t('helpCenter:site.home.searchHint')}
          />
        }
      />
      {toggle(
        'categories',
        t('helpCenter:site.home.categories'),
        t('helpCenter:site.home.categoriesHint'),
      )}
      {toggle(
        'featured',
        t('helpCenter:site.home.featured'),
        t('helpCenter:site.home.featuredHint'),
      )}
      {draft.featured ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, paddingInlineStart: 7 }}>
          <Box
            component="ol"
            aria-label={t('helpCenter:site.home.featuredList')}
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 2,
              listStyle: 'none',
              margin: 0,
              padding: 0,
            }}
          >
            {draft.featuredArticleIds.map((articleId, index) => {
              const title = titleOf(articleId);
              return (
                <Box
                  component="li"
                  key={articleId}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 1,
                    height: 32,
                    paddingInline: 1,
                    borderRadius: '6px',
                    border: `1px solid ${tokens['border.strong']}`,
                    backgroundColor: tokens['bg.surface'],
                    fontSize: 13,
                  }}
                >
                  {canManage ? (
                    <IconButton
                      size="small"
                      aria-label={t('helpCenter:site.home.move', { title })}
                      onKeyDown={(event: KeyboardEvent) => {
                        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                          event.preventDefault();
                          move(index, -1);
                        } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                          event.preventDefault();
                          move(index, 1);
                        }
                      }}
                      sx={{ width: 24, height: 24 }}
                    >
                      <GripVertical size={14} aria-hidden="true" />
                    </IconButton>
                  ) : null}
                  <span>{title}</span>
                  {canManage ? (
                    <IconButton
                      size="small"
                      aria-label={t('helpCenter:site.home.remove', { title })}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          featuredArticleIds: draft.featuredArticleIds.filter(
                            (candidate) => candidate !== articleId,
                          ),
                        })
                      }
                      sx={{ width: 24, height: 24 }}
                    >
                      <X size={14} aria-hidden="true" />
                    </IconButton>
                  ) : null}
                </Box>
              );
            })}
          </Box>
          {canManage && draft.featuredArticleIds.length < HC_FEATURED_MAX ? (
            <Box sx={{ display: 'inline-flex', gap: 1, alignItems: 'center' }}>
              <Select
                size="small"
                displayEmpty
                value={adding}
                onChange={(event) => setAdding(String(event.target.value))}
                SelectDisplayProps={{ 'aria-label': t('helpCenter:site.home.addLabel') }}
                sx={{ minWidth: 200, height: 32 }}
              >
                <MenuItem value="">
                  <em>{t('helpCenter:site.home.addLabel')}</em>
                </MenuItem>
                {choices.map((article) => (
                  <MenuItem key={article.id} value={article.id}>
                    {titleOf(article.id)}
                  </MenuItem>
                ))}
              </Select>
              <Button
                size="small"
                variant="text"
                disabled={adding === ''}
                startIcon={<Plus size={16} aria-hidden="true" />}
                onClick={() => {
                  setDraft({ ...draft, featuredArticleIds: [...draft.featuredArticleIds, adding] });
                  setAdding('');
                }}
              >
                {t('helpCenter:site.home.add')}
              </Button>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {toggle('popular', t('helpCenter:site.home.popular'), t('helpCenter:site.home.popularHint'))}
    </SectionCard>
  );
}

function Label({ text, hint }: { readonly text: string; readonly hint: string }): ReactNode {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', paddingBlockStart: '6px' }}>
      <Typography component="span" sx={{ fontSize: 14, fontWeight: 500 }}>
        {text}
      </Typography>
      <Typography
        component="span"
        variant="caption"
        sx={{ color: 'text.secondary', fontWeight: 400 }}
      >
        {hint}
      </Typography>
    </Box>
  );
}
