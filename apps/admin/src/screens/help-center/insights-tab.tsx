import {
  HC_INSIGHTS_PERIODS,
  type HcArticleStats,
  type HcInsightsQuery,
  type HcInsightsSort,
  type HcLocale,
  type HcZeroResultSearch,
} from '@helpdock/schemas';
import {
  Box,
  Button,
  MenuItem,
  Link as MuiLink,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FilePlus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useT } from '../../app/i18n.js';
import { articleRoute } from '../../app/route-paths.js';
import { useSemanticTokens } from '../../app/tokens.js';
import { helpCenterKeys } from '../../help-center/api.js';
import { AlertBanner } from '../../ui/alert-banner.tsx';
import { visuallyHidden } from '../../ui/visually-hidden.js';
import { orderedCategories, sectionsOf } from './article-rows.js';
import { formatDay } from './time.js';
import { useHelpCenter, useHelpCenterReport, useReaderLocale } from './use-help-center.js';

/**
 * Help center › Insights (M5-08, `Admin/HelpCenter-Settings` board 2): the
 * period and language filters, Top searches and Searches with no results side
 * by side, and the Articles table of views and "Was this helpful?" answers.
 *
 * Every count is the api's; this screen only draws them. A search nobody's
 * article answers has "Write article" beside it for someone who may write one,
 * which opens a draft titled with the search.
 */

const mono = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 } as const;
const numeric = { ...mono, textAlign: 'end' } as const;

type LocaleFilter = 'all' | HcLocale;

const percent = (share: number): string => `${Math.round(share * 100)} %`;

export function InsightsTab({ canManage }: { readonly canManage: boolean }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { brand, api } = useHelpCenter();
  const [days, setDays] = useState<number>(30);
  const [language, setLanguage] = useState<LocaleFilter>('all');
  const [sort, setSort] = useState<HcInsightsSort>('views');
  const query: HcInsightsQuery = {
    days,
    sort,
    ...(language === 'all' ? {} : { locale: language }),
  };
  const insights = useQuery({
    queryKey: helpCenterKeys.insights(brand.id, query),
    queryFn: () => api.insights(brand.id, query),
  });

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

  const card = {
    borderRadius: '10px',
    border: `1px solid ${tokens['border.default']}`,
    backgroundColor: tokens['bg.surface'],
    overflow: 'hidden',
    minWidth: 0,
  } as const;
  const headRow = { backgroundColor: tokens['bg.muted'] } as const;

  const data = insights.data;
  const loading = (rows: number) =>
    [0, 1, 2, 3]
      .slice(0, rows)
      .map((row) => (
        <Skeleton
          key={row}
          variant="rounded"
          height={28}
          sx={{ marginInline: 4, marginBlock: 1 }}
        />
      ));
  const empty = (columns: number, text: string) => (
    <TableRow>
      <TableCell colSpan={columns} sx={{ color: 'text.secondary', fontSize: 13 }}>
        {text}
      </TableCell>
    </TableRow>
  );

  const header = (id: string, heading: string, body: string, aside?: ReactNode) => (
    <Box
      sx={{ paddingBlock: 3, paddingInline: 4, display: 'flex', alignItems: 'flex-start', gap: 3 }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', flexGrow: 1 }}>
        <Typography variant="h3" component="h2" id={id}>
          {heading}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {body}
        </Typography>
      </Box>
      {aside}
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        {select(
          t('helpCenter:insights.period'),
          String(days),
          HC_INSIGHTS_PERIODS.map((period) => [
            String(period),
            t(`helpCenter:insights.periods.${period}`),
          ]),
          (value) => {
            setDays(Number(value));
          },
        )}
        {select(
          t('helpCenter:insights.language'),
          language,
          (['all', 'en', 'ar'] as const).map((key) => [
            key,
            t(`helpCenter:insights.languages.${key}`),
          ]),
          (value) => {
            setLanguage(value as LocaleFilter);
          },
        )}
        <Typography
          variant="caption"
          sx={{ marginInlineStart: 'auto', color: 'text.secondary', lineHeight: '16px' }}
        >
          {t('helpCenter:insights.retention')}
        </Typography>
      </Box>

      {insights.isError ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
          <AlertBanner tone="danger">{t('helpCenter:insights.failed')}</AlertBanner>
          <Button
            variant="outlined"
            onClick={() => {
              void insights.refetch();
            }}
          >
            {t('helpCenter:insights.retry')}
          </Button>
        </Box>
      ) : null}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
          gap: 6,
          alignItems: 'start',
        }}
      >
        <Box component="section" aria-labelledby="hc-top-searches" sx={card}>
          {header(
            'hc-top-searches',
            t('helpCenter:insights.top.heading'),
            t('helpCenter:insights.top.body'),
          )}
          {data === undefined ? (
            loading(4)
          ) : (
            <Table size="small" aria-labelledby="hc-top-searches">
              <TableHead>
                <TableRow sx={headRow}>
                  <TableCell>{t('helpCenter:insights.top.search')}</TableCell>
                  <TableCell sx={{ width: 96, textAlign: 'end' }}>
                    {t('helpCenter:insights.top.searches')}
                  </TableCell>
                  <TableCell sx={{ width: 128, textAlign: 'end' }}>
                    {t('helpCenter:insights.top.opened')}
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.topSearches.length === 0
                  ? empty(3, t('helpCenter:insights.top.empty'))
                  : data.topSearches.map((row) => (
                      <TableRow key={`${row.locale}:${row.query}`}>
                        <TableCell sx={{ fontWeight: 500 }}>
                          <SearchText query={row.query} locale={row.locale} />
                        </TableCell>
                        <TableCell sx={numeric}>{row.searches.toLocaleString('en-US')}</TableCell>
                        <TableCell sx={numeric}>{percent(row.openedRate)}</TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          )}
        </Box>

        <Box component="section" aria-labelledby="hc-zero-searches" sx={card}>
          {header(
            'hc-zero-searches',
            t('helpCenter:insights.zero.heading'),
            t('helpCenter:insights.zero.body'),
          )}
          {data === undefined ? (
            loading(3)
          ) : (
            <Table size="small" aria-labelledby="hc-zero-searches">
              <TableHead>
                <TableRow sx={headRow}>
                  <TableCell>{t('helpCenter:insights.top.search')}</TableCell>
                  <TableCell sx={{ width: 96, textAlign: 'end' }}>
                    {t('helpCenter:insights.top.searches')}
                  </TableCell>
                  <TableCell sx={{ width: 96 }}>{t('helpCenter:insights.zero.last')}</TableCell>
                  {canManage ? (
                    <TableCell sx={{ width: 128 }}>
                      <Box component="span" sx={visuallyHidden}>
                        {t('helpCenter:insights.zero.action')}
                      </Box>
                    </TableCell>
                  ) : null}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.zeroResultSearches.length === 0
                  ? empty(canManage ? 4 : 3, t('helpCenter:insights.zero.empty'))
                  : data.zeroResultSearches.map((row) => (
                      <ZeroResultRow
                        key={`${row.locale}:${row.query}`}
                        row={row}
                        canManage={canManage}
                      />
                    ))}
              </TableBody>
            </Table>
          )}
        </Box>
      </Box>

      <Box component="section" aria-labelledby="hc-article-stats" sx={card}>
        {header(
          'hc-article-stats',
          t('helpCenter:insights.articles.heading'),
          t('helpCenter:insights.articles.body'),
          select(
            t('helpCenter:insights.articles.sort'),
            sort,
            (['views', 'least_helpful'] as const).map((key) => [
              key,
              t(`helpCenter:insights.articles.sorts.${key}`),
            ]),
            (value) => {
              setSort(value as HcInsightsSort);
            },
          ),
        )}
        {data === undefined ? (
          loading(4)
        ) : (
          <Table size="small" aria-labelledby="hc-article-stats">
            <TableHead>
              <TableRow sx={headRow}>
                <TableCell>{t('helpCenter:insights.articles.article')}</TableCell>
                <TableCell sx={{ width: 96, textAlign: 'end' }}>
                  {t('helpCenter:insights.articles.views')}
                </TableCell>
                <TableCell sx={{ width: 280 }}>
                  {t('helpCenter:insights.articles.helpful')}
                </TableCell>
                <TableCell sx={{ width: 120 }}>
                  {t('helpCenter:insights.articles.comments')}
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.articles.length === 0
                ? empty(4, t('helpCenter:insights.articles.empty'))
                : data.articles.map((row) => <ArticleStatsRow key={row.articleId} row={row} />)}
            </TableBody>
          </Table>
        )}
      </Box>
    </Box>
  );
}

/** A query in the language it was typed in, so an Arabic one reads right to left on an English page. */
function SearchText({ query, locale }: { readonly query: string; readonly locale: HcLocale }) {
  return (
    <bdi lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      {query}
    </bdi>
  );
}

function ZeroResultRow({
  row,
  canManage,
}: {
  readonly row: HcZeroResultSearch;
  readonly canManage: boolean;
}): ReactNode {
  const t = useT();
  const locale = useReaderLocale();
  const navigate = useNavigate();
  const report = useHelpCenterReport();
  const { brand, api, structure } = useHelpCenter();
  const timezone = structure.data?.timezone ?? 'UTC';
  const firstSection =
    structure.data === undefined
      ? undefined
      : orderedCategories(structure.data)
          .flatMap((category) => sectionsOf(structure.data, category.id))
          .at(0)?.id;

  const write = useMutation({
    mutationFn: (sectionId: string) =>
      api.createArticle(brand.id, {
        sectionId,
        locale: row.locale,
        title: row.query.slice(0, 200),
      }),
    onSuccess: (article) => {
      void navigate(articleRoute(article.id));
    },
    onError: report,
  });

  return (
    <TableRow>
      <TableCell sx={{ fontWeight: 500 }}>
        <SearchText query={row.query} locale={row.locale} />
      </TableCell>
      <TableCell sx={numeric}>{row.searches.toLocaleString('en-US')}</TableCell>
      <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>
        {formatDay(row.lastSearchedAt, locale, timezone)}
      </TableCell>
      {canManage ? (
        <TableCell>
          <Button
            variant="text"
            size="small"
            startIcon={<FilePlus size={14} aria-hidden="true" />}
            aria-label={t('helpCenter:insights.zero.writeLabel', { query: row.query })}
            disabled={firstSection === undefined || write.isPending}
            onClick={() => {
              if (firstSection !== undefined) {
                write.mutate(firstSection);
              }
            }}
            sx={{ fontSize: 12, paddingInline: 1 }}
          >
            {t('helpCenter:insights.zero.write')}
          </Button>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

function ArticleStatsRow({ row }: { readonly row: HcArticleStats }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const share = row.votes === 0 ? 0 : row.helpful / row.votes;

  return (
    <TableRow>
      <TableCell
        sx={{ maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        <MuiLink
          component={Link}
          to={articleRoute(row.articleId)}
          sx={{ color: 'text.primary', fontWeight: 500 }}
        >
          {row.title}
        </MuiLink>
      </TableCell>
      <TableCell sx={numeric}>{row.views.toLocaleString('en-US')}</TableCell>
      <TableCell>
        {row.votes === 0 ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('helpCenter:insights.articles.noVotes')}
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box
              aria-hidden="true"
              sx={{
                width: 96,
                height: 6,
                borderRadius: '999px',
                backgroundColor: tokens['bg.muted'],
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              <Box
                sx={{
                  width: `${Math.round(share * 100)}%`,
                  height: 6,
                  backgroundColor: tokens['action.primary'],
                }}
              />
            </Box>
            <Box component="span" sx={{ ...mono, width: 40, textAlign: 'end' }}>
              {percent(share)}
            </Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {t('helpCenter:insights.articles.ofVotes', {
                helpful: row.helpful.toLocaleString('en-US'),
                votes: row.votes.toLocaleString('en-US'),
              })}
            </Typography>
          </Box>
        )}
      </TableCell>
      <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>
        {row.comments === 0
          ? '—'
          : t('helpCenter:insights.articles.commentCount', { count: row.comments })}
      </TableCell>
    </TableRow>
  );
}
