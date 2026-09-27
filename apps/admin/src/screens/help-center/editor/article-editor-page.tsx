import {
  type HcArticle,
  type HcArticleStatus,
  type HcLocale,
  type HcStructure,
  type HcVersion,
  hcSlugSchema,
} from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Editor } from '@tiptap/core';
import { ArrowLeft, Check, LoaderCircle } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { helpCenterRoute } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useSession } from '../../../auth/session.tsx';
import { helpCenterKeys, isHelpCenterError } from '../../../help-center/api.js';
import { useToast } from '../../../ui/toasts.tsx';
import { breadcrumb } from '../article-rows.js';
import { managesHelpCenter } from '../help-center-page.tsx';
import { fromWallClock, toWallClock } from '../time.js';
import { useHelpCenter, useHelpCenterReport } from '../use-help-center.js';
import { RichTextEditor } from './rich-text-editor.tsx';
import { type ScheduleDraft, SettingsPanel } from './settings-panel.tsx';

/**
 * `Admin/HelpCenter-Editor` (M5-02): the top bar, the page, and the settings
 * panel, for one language of one article at a time.
 *
 * The page autosaves the working copy a moment after typing stops; nothing a
 * visitor reads changes until "Publish changes" (or the scheduled time). A
 * status, visibility or slug change applies at once, since each is a switch
 * rather than prose.
 */

/** How long typing has to pause before the working copy is saved. */
export const AUTOSAVE_MS = 800;
/** How often, and how many times, a converting image is asked about. */
const IMAGE_POLL_MS = 500;
const IMAGE_POLL_TRIES = 40;

export function ArticleEditorPage({ articleId }: { readonly articleId: string }): ReactNode {
  const t = useT();
  const { locale: reader } = usePreferences();
  const { brand, api, structure } = useHelpCenter();
  const article = useQuery({
    queryKey: helpCenterKeys.article(brand.id, articleId),
    queryFn: () => api.article(brand.id, articleId),
  });
  const [locale, setLocale] = useState<HcLocale | null>(null);

  if (article.data === undefined || structure.data === undefined) {
    return article.isError || structure.isError ? (
      <Typography role="alert" sx={{ padding: 6, color: 'text.secondary' }}>
        {t('helpCenter:editor.notFound')}
      </Typography>
    ) : null;
  }

  const active =
    locale ??
    (article.data.versions.some((version) => version.locale === reader)
      ? reader
      : (article.data.versions[0]?.locale ?? structure.data.defaultLocale));

  return (
    <LocaleEditor
      key={active}
      article={article.data}
      structure={structure.data}
      locale={active}
      onLocale={setLocale}
    />
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

function LocaleEditor({
  article,
  structure,
  locale,
  onLocale,
}: {
  readonly article: HcArticle;
  readonly structure: HcStructure;
  readonly locale: HcLocale;
  onLocale(locale: HcLocale): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const report = useHelpCenterReport();
  const queryClient = useQueryClient();
  const session = useSession();
  const { locale: reader } = usePreferences();
  const { brand, api } = useHelpCenter();
  const editable = managesHelpCenter(session.user.role);
  const version: HcVersion | undefined = article.versions.find((row) => row.locale === locale);

  const [title, setTitle] = useState(version?.title ?? '');
  const [html, setHtml] = useState(version?.bodyHtml ?? '');
  const [description, setDescription] = useState(version?.description ?? '');
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [slug, setSlug] = useState(article.slug);
  const [slugError, setSlugError] = useState<string | undefined>(undefined);
  const [choice, setChoice] = useState<HcArticleStatus>(version?.status ?? 'draft');
  const [schedule, setSchedule] = useState<ScheduleDraft>(() =>
    toWallClock(
      version?.scheduledAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      structure.timezone,
    ),
  );
  const [scheduleError, setScheduleError] = useState<string | undefined>(undefined);
  const editorRef = useRef<Editor | null>(null);
  const pending = useRef<Promise<unknown> | null>(null);

  const keep = (next: HcArticle): void => {
    queryClient.setQueryData(helpCenterKeys.article(brand.id, article.id), next);
    void queryClient.invalidateQueries({ queryKey: helpCenterKeys.structure(brand.id) });
  };

  const save = useMutation({
    mutationFn: () =>
      api.saveVersion(brand.id, article.id, locale, {
        title: title.trim(),
        description: description.trim(),
        bodyHtml: html,
      }),
    onMutate: () => {
      setSaveState('saving');
    },
    onSuccess: (next) => {
      keep(next);
      setDirty(false);
      setSaveState('saved');
      setSavedAt(new Date().toISOString());
    },
    onError: (error) => {
      setSaveState('failed');
      report(error);
    },
  });

  const flush = async (): Promise<void> => {
    if (pending.current !== null) {
      await pending.current.catch(() => undefined);
    }
    if (dirty && title.trim() !== '') {
      await save.mutateAsync();
    }
  };

  // Re-armed by every edit (`revision`), and reading the save through a ref so
  // the timer always sends the draft as it is when it fires.
  const autosave = useRef(save.mutateAsync);
  autosave.current = save.mutateAsync;
  const ready = dirty && editable && title.trim() !== '';
  useEffect(() => {
    if (!ready || revision === 0) {
      return;
    }
    const timer = setTimeout(() => {
      pending.current = autosave.current().catch(() => undefined);
    }, AUTOSAVE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [ready, revision]);

  const status = useMutation({
    mutationFn: async (next: { status: HcArticleStatus; scheduledAt?: string }) => {
      await flush();
      return api.setStatus(brand.id, article.id, locale, next);
    },
    onSuccess: (next, input) => {
      keep(next);
      setChoice(input.status);
      toast({ tone: 'success', message: t(`helpCenter:toast.status.${input.status}`) });
    },
    onError: (error) => {
      setChoice(version?.status ?? 'draft');
      report(error);
    },
  });

  const visibility = useMutation({
    mutationFn: (next: 'public' | 'internal') =>
      api.setVisibility(brand.id, article.id, locale, next),
    onSuccess: (next, input) => {
      keep(next);
      toast({ tone: 'success', message: t(`helpCenter:toast.visibility.${input}`) });
    },
    onError: report,
  });

  const rename = useMutation({
    mutationFn: (next: string) => api.updateArticle(brand.id, article.id, { slug: next }),
    onSuccess: (next) => {
      keep(next);
      setSlugError(undefined);
      toast({ tone: 'success', message: t('helpCenter:toast.slug') });
    },
    onError: (error) => {
      if (isHelpCenterError(error) && error.reason === 'slug-taken') {
        setSlugError(t('helpCenter:refusals.slug-taken'));
        return;
      }
      report(error);
    },
  });

  const onImage = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        const upload = await api.presignImage(brand.id, {
          fileName: file.name || 'pasted-image.png',
          mime: file.type as 'image/png',
          size: file.size,
        });
        await api.uploadImage(upload, file);
        let media = await api.confirmImage(brand.id, upload.mediaId);
        for (let tries = 0; media.status === 'processing' && tries < IMAGE_POLL_TRIES; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, IMAGE_POLL_MS));
          media = await api.image(brand.id, upload.mediaId);
        }
        if (media.status !== 'ready' || media.src === null) {
          toast({ tone: 'danger', message: t('helpCenter:editor.imageRejected') });
          return null;
        }
        return media.src;
      } catch (error) {
        report(error);
        return null;
      }
    },
    [api, brand.id, report, t, toast],
  );

  const busy = status.isPending || visibility.isPending || rename.isPending;
  const published = version?.status === 'published';
  const changed = dirty || version?.hasUnpublishedChanges === true;
  const primary =
    choice === 'scheduled'
      ? t('helpCenter:editor.schedule')
      : published
        ? t('helpCenter:editor.publishChanges')
        : t('helpCenter:editor.publish');

  const runPrimary = (): void => {
    if (choice === 'scheduled') {
      const at = fromWallClock(schedule, structure.timezone);
      if (at === null || Date.parse(at) <= Date.now()) {
        setScheduleError(t('helpCenter:refusals.schedule-in-past'));
        return;
      }
      setScheduleError(undefined);
      status.mutate({ status: 'scheduled', scheduledAt: at });
      return;
    }
    status.mutate({ status: 'published' });
  };

  const exportMarkdown = (): void => {
    const markdown = editorRef.current?.getMarkdown() ?? '';
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${article.slug}.${locale}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importMarkdown = async (file: File): Promise<void> => {
    const editor = editorRef.current;
    if (editor === null) {
      return;
    }
    editor.commands.setContent(await file.text(), { contentType: 'markdown' });
    setHtml(editor.getHTML());
    setDirty(true);
    setRevision((current) => current + 1);
    toast({ tone: 'success', message: t('helpCenter:toast.imported') });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box
        sx={{
          minHeight: 56,
          paddingInline: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          flexWrap: 'wrap',
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.canvas'],
          flexShrink: 0,
        }}
      >
        <Button
          size="small"
          variant="text"
          component={Link}
          to={`${helpCenterRoute('articles')}?section=${article.sectionId}`}
          startIcon={
            <Box
              component="span"
              sx={{ display: 'inline-flex', '[dir="rtl"] &': { transform: 'scaleX(-1)' } }}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </Box>
          }
        >
          {t('helpCenter:editor.back')}
        </Button>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {breadcrumb(structure, article.sectionId, reader)}
        </Typography>
        <Box
          role="status"
          sx={{
            marginInlineStart: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: 12,
            color: saveState === 'failed' ? tokens['status.danger.text'] : 'text.secondary',
          }}
        >
          {saveState === 'saving' ? (
            <>
              <LoaderCircle size={14} aria-hidden="true" />
              {t('helpCenter:editor.saving')}
            </>
          ) : saveState === 'saved' && savedAt !== null ? (
            <>
              <Check size={14} aria-hidden="true" />
              {t('helpCenter:editor.saved', {
                time: toWallClock(savedAt, Intl.DateTimeFormat().resolvedOptions().timeZone).time,
              })}
            </>
          ) : saveState === 'failed' ? (
            t('helpCenter:editor.saveFailed')
          ) : null}
        </Box>
        {editable ? (
          <Button
            variant="contained"
            disabled={
              busy ||
              (version === undefined && !dirty) ||
              title.trim() === '' ||
              (choice !== 'scheduled' && published && !changed)
            }
            onClick={runPrimary}
          >
            {primary}
          </Button>
        ) : null}
      </Box>

      <Box
        sx={{
          flexGrow: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: { xs: 'column', lg: 'row' },
        }}
      >
        <RichTextEditor
          locale={locale}
          title={title}
          html={html}
          editable={editable}
          onTitle={(next) => {
            setTitle(next);
            setDirty(true);
            setRevision((current) => current + 1);
          }}
          onChange={(next) => {
            setHtml(next);
            setDirty(true);
            setRevision((current) => current + 1);
          }}
          onImage={onImage}
          onReady={(editor) => {
            editorRef.current = editor;
          }}
        />
        <SettingsPanel
          locale={locale}
          defaultLocale={structure.defaultLocale}
          timezone={structure.timezone}
          versions={article.versions}
          version={version}
          status={choice}
          schedule={schedule}
          scheduleError={scheduleError}
          slug={slug}
          slugError={slugError}
          description={description}
          activity={article.activity}
          editable={editable}
          busy={busy}
          auditLogLink={session.user.installAdmin}
          onLocale={(next) => {
            if (next !== locale) {
              void flush().finally(() => {
                onLocale(next);
              });
            }
          }}
          onStatus={(next) => {
            if (next === 'scheduled') {
              setChoice('scheduled');
              return;
            }
            setChoice(next);
            if (next === 'published') {
              status.mutate({ status: 'published' });
            } else if (next !== version?.status) {
              status.mutate({ status: next });
            }
          }}
          onSchedule={(next) => {
            setSchedule(next);
            setScheduleError(undefined);
          }}
          onVisibility={(next) => {
            visibility.mutate(next);
          }}
          onSlug={(next) => {
            setSlug(next);
            setSlugError(undefined);
          }}
          onSlugCommit={() => {
            if (slug === article.slug) {
              return;
            }
            const parsed = hcSlugSchema.safeParse(slug);
            if (!parsed.success) {
              setSlugError(t('helpCenter:panel.address.slugInvalid'));
              return;
            }
            setSlug(parsed.data);
            rename.mutate(parsed.data);
          }}
          onDescription={(next) => {
            setDescription(next);
            setDirty(true);
            setRevision((current) => current + 1);
          }}
          onImportMarkdown={(file) => {
            void importMarkdown(file);
          }}
          onExportMarkdown={exportMarkdown}
        />
      </Box>
    </Box>
  );
}
