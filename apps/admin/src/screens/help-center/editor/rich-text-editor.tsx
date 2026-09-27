import { HC_TITLE_MAX, type HcLocale, slugify, videoEmbedUrl } from '@helpdock/schemas';
import { Box, IconButton, MenuItem, Select, TextField, Typography } from '@mui/material';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import {
  Bold,
  Code,
  Hash,
  Image as ImageIcon,
  Italic,
  Lightbulb,
  Link as LinkIcon,
  List,
  ListOrdered,
  type LucideIcon,
  PilcrowLeft,
  Table,
  Video,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { ConfirmDialog } from '../../../ui/confirm-dialog.tsx';
import { Field, fieldDescribedBy } from '../../../ui/field.tsx';
import { visuallyHidden } from '../../../ui/visually-hidden.js';
import { articleExtensions } from './extensions.js';

/**
 * The article editor (M5-02, ADR 0001, DESIGN §6.3 ArticleEditor): TipTap
 * with the toolbar of `Admin/HelpCenter-Editor` — text style, bold, italic,
 * lists, link, anchor, image, video, table, code block, callout and the
 * block's direction — over a 720 px page with the title above the body.
 *
 * Direction is `textDirection: 'auto'` (ADR 0001), so an English code sample
 * inside an Arabic article keeps its own direction per block, and the
 * direction control overrides one block. The page itself is `dir="rtl"` for
 * an Arabic version, which is what "Arabic is edited right to left" means.
 *
 * Pasting or choosing an image hands the file to `onImage`, which runs it
 * through the media pipeline (presign, upload, confirm, WebP) and answers the
 * `src` to insert.
 */

export interface RichTextEditorProps {
  readonly locale: HcLocale;
  readonly title: string;
  readonly html: string;
  readonly editable: boolean;
  onTitle(title: string): void;
  onChange(html: string): void;
  onImage(file: File): Promise<string | null>;
  /** The live editor, for Markdown import and export. */
  onReady?(editor: Editor | null): void;
}

type Dialog = { kind: 'link' } | { kind: 'video' } | null;

/** What a link may point at: the sanitiser's `ARTICLE_LINK`, so a refused one is refused here first. */
// A string, not a regex literal: `pnpm check:routes` tokenises every app file,
// and its scanner reads the `#` of a regex literal as a private name.
// biome-ignore lint/complexity/useRegexLiterals: a literal stalls that scanner.
const LINK_TARGET = new RegExp('^(?:https?:|mailto:|tel:|#|/(?!/))', 'i');

export function RichTextEditor({
  locale,
  title,
  html,
  editable,
  onTitle,
  onChange,
  onImage,
  onReady,
}: RichTextEditorProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const titleId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [uploading, setUploading] = useState(false);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const insertImage = async (editor: Editor, file: File): Promise<void> => {
    setUploading(true);
    try {
      const src = await onImage(file);
      if (src !== null) {
        editor.chain().focus().setImage({ src, alt: '' }).run();
      }
    } finally {
      setUploading(false);
    }
  };

  const editor = useEditor({
    extensions: articleExtensions(),
    content: html,
    editable,
    textDirection: 'auto',
    immediatelyRender: true,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': t('helpCenter:editor.body'),
        lang: locale,
        class: 'hc-article-body',
      },
      handlePaste: (_view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((candidate) =>
          candidate.type.startsWith('image/'),
        );
        if (file === undefined || editor === null) {
          return false;
        }
        void insertImage(editor, file);
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      onChange(current.getHTML());
    },
  });

  useEffect(() => {
    onReady?.(editor);
    return () => onReady?.(null);
  }, [editor, onReady]);

  useEffect(() => {
    // `false`: switching modes is not an edit, and must not autosave.
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive('bold') ?? false,
      italic: current?.isActive('italic') ?? false,
      bullet: current?.isActive('bulletList') ?? false,
      ordered: current?.isActive('orderedList') ?? false,
      code: current?.isActive('codeBlock') ?? false,
      callout: current?.isActive('callout') ?? false,
      link: current?.isActive('link') ?? false,
      block: current?.isActive('heading', { level: 2 })
        ? 'h2'
        : current?.isActive('heading', { level: 3 })
          ? 'h3'
          : 'p',
      anchor: current?.isActive('heading')
        ? String(current.getAttributes('heading').id ?? '')
        : null,
    }),
  });

  const button = (
    label: string,
    Icon: LucideIcon,
    onClick: () => void,
    pressed?: boolean,
  ): ReactNode => (
    <IconButton
      size="small"
      aria-label={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      disabled={!editable || editor === null}
      onClick={onClick}
      sx={{
        width: 32,
        height: 32,
        borderRadius: '6px',
        color: pressed ? tokens['action.primary'] : 'text.primary',
        backgroundColor: pressed ? tokens['action.primary.tint'] : 'transparent',
      }}
    >
      <Icon size={16} aria-hidden="true" />
    </IconButton>
  );
  const divider = (
    <Box
      aria-hidden="true"
      sx={{
        width: '1px',
        height: 20,
        backgroundColor: tokens['border.default'],
        marginInline: 1,
        flexShrink: 0,
      }}
    />
  );

  const chain = () => editor?.chain().focus();

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Box
        role="toolbar"
        aria-label={t('helpCenter:editor.toolbar')}
        sx={{
          minHeight: 48,
          paddingInline: 4,
          display: 'flex',
          alignItems: 'center',
          gap: '2px',
          flexWrap: 'wrap',
          borderBlockEnd: `1px solid ${tokens['border.default']}`,
        }}
      >
        <Select
          size="small"
          value={state?.block ?? 'p'}
          disabled={!editable || editor === null}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'p') {
              chain()?.setParagraph().run();
            } else {
              chain()
                ?.setHeading({ level: value === 'h2' ? 2 : 3 })
                .run();
            }
          }}
          inputProps={{ 'aria-label': t('helpCenter:editor.textStyle') }}
          SelectDisplayProps={{ 'aria-label': t('helpCenter:editor.textStyle') }}
          sx={{ height: 32, fontSize: 13, marginInlineEnd: '6px' }}
        >
          <MenuItem value="p">{t('helpCenter:editor.paragraph')}</MenuItem>
          <MenuItem value="h2">{t('helpCenter:editor.heading2')}</MenuItem>
          <MenuItem value="h3">{t('helpCenter:editor.heading3')}</MenuItem>
        </Select>
        {button(t('helpCenter:editor.bold'), Bold, () => chain()?.toggleBold().run(), state?.bold)}
        {button(
          t('helpCenter:editor.italic'),
          Italic,
          () => chain()?.toggleItalic().run(),
          state?.italic,
        )}
        {divider}
        {button(
          t('helpCenter:editor.bullets'),
          List,
          () => chain()?.toggleBulletList().run(),
          state?.bullet,
        )}
        {button(
          t('helpCenter:editor.numbers'),
          ListOrdered,
          () => chain()?.toggleOrderedList().run(),
          state?.ordered,
        )}
        {divider}
        {button(t('helpCenter:editor.link'), LinkIcon, () => {
          if (state?.link) {
            chain()?.unsetLink().run();
          } else {
            setDialog({ kind: 'link' });
          }
        })}
        {button(
          t('helpCenter:editor.anchor'),
          Hash,
          () => {
            if (editor === null || state?.anchor === null) {
              return;
            }
            const { $from } = editor.state.selection;
            const text = $from.parent.textContent;
            chain()
              ?.updateAttributes('heading', { id: state?.anchor ? null : slugify(text, 'section') })
              .run();
          },
          state?.anchor === null ? undefined : state?.anchor !== '',
        )}
        {divider}
        {button(t('helpCenter:editor.image'), ImageIcon, () => fileInput.current?.click())}
        {button(t('helpCenter:editor.video.button'), Video, () => {
          setDialog({ kind: 'video' });
        })}
        {button(t('helpCenter:editor.table'), Table, () =>
          chain()?.insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run(),
        )}
        {divider}
        {button(
          t('helpCenter:editor.code'),
          Code,
          () => chain()?.toggleCodeBlock().run(),
          state?.code,
        )}
        {button(
          t('helpCenter:editor.callout.button'),
          Lightbulb,
          () => chain()?.toggleCallout().run(),
          state?.callout,
        )}
        {divider}
        {button(t('helpCenter:editor.direction'), PilcrowLeft, () => {
          if (editor === null) {
            return;
          }
          const current = editor.state.selection.$from.parent.attrs.dir as string | undefined;
          const next = current === 'rtl' ? 'ltr' : current === 'ltr' ? null : 'rtl';
          if (next === null) {
            chain()?.unsetTextDirection().run();
          } else {
            chain()?.setTextDirection(next).run();
          }
        })}
        <Typography
          variant="caption"
          role="status"
          sx={{ marginInlineStart: 'auto', color: 'text.secondary', fontWeight: 400 }}
        >
          {uploading ? t('helpCenter:editor.uploading') : t('helpCenter:editor.pasteHint')}
        </Typography>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          tabIndex={-1}
          aria-hidden="true"
          style={visuallyHidden}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file !== undefined && editor !== null) {
              void insertImage(editor, file);
            }
          }}
        />
      </Box>

      <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: 'auto' }}>
        <Box
          dir={dir}
          lang={locale}
          sx={{
            maxWidth: 720,
            marginInline: 'auto',
            paddingBlock: '28px 32px',
            paddingInline: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: 16,
            lineHeight: '24px',
            '& .hc-article-body': {
              outline: 0,
              minHeight: 240,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            },
            '& .hc-article-body > *': { margin: 0 },
            '& .hc-article-body h2': { fontSize: 20, lineHeight: '28px', fontWeight: 600 },
            '& .hc-article-body h3': { fontSize: 16, lineHeight: '24px', fontWeight: 600 },
            '& .hc-article-body h2[id]::after, & .hc-article-body h3[id]::after': {
              content: '" #" attr(id)',
              fontFamily: '"IBM Plex Mono", monospace',
              fontSize: 12,
              fontWeight: 400,
              color: tokens['text.secondary'],
            },
            '& .hc-article-body table': {
              borderCollapse: 'collapse',
              width: '100%',
              fontSize: 14,
              lineHeight: '20px',
            },
            '& .hc-article-body th, & .hc-article-body td': {
              border: `1px solid ${tokens['border.default']}`,
              paddingBlock: 2,
              paddingInline: '14px',
              textAlign: 'start',
              verticalAlign: 'top',
            },
            '& .hc-article-body th': { backgroundColor: tokens['bg.muted'], fontWeight: 500 },
            '& .hc-article-body th p, & .hc-article-body td p': { margin: 0 },
            '& .hc-article-body pre': {
              borderRadius: '6px',
              backgroundColor: tokens['bg.muted'],
              padding: '10px 12px',
              fontFamily: '"IBM Plex Mono", monospace',
              fontSize: 13,
              lineHeight: '20px',
              direction: 'ltr',
              textAlign: 'left',
            },
            '& .hc-article-body img': { maxWidth: '100%', borderRadius: '10px' },
            '& .hc-article-body a': { color: tokens['text.link'] },
            '& .hc-article-body blockquote': {
              borderInlineStart: `2px solid ${tokens['border.strong']}`,
              paddingInlineStart: 3,
            },
          }}
        >
          <Box component="label" htmlFor={titleId} sx={visuallyHidden}>
            {t('helpCenter:editor.title')}
          </Box>
          <Box
            component="input"
            id={titleId}
            type="text"
            value={title}
            maxLength={HC_TITLE_MAX}
            readOnly={!editable}
            placeholder={t('helpCenter:editor.titlePlaceholder')}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
              onTitle(event.target.value);
            }}
            sx={{
              height: 48,
              padding: 0,
              border: 0,
              borderBlockEnd: `1px solid ${tokens['border.default']}`,
              backgroundColor: 'transparent',
              fontSize: 32,
              lineHeight: '40px',
              fontWeight: 600,
              fontFamily: 'inherit',
              color: 'text.primary',
              '&:focus-visible': {
                outline: `2px solid ${tokens['border.focus']}`,
                outlineOffset: '2px',
              },
            }}
          />
          <EditorContent editor={editor} />
        </Box>
      </Box>

      <UrlDialog
        dialog={dialog}
        onClose={() => {
          setDialog(null);
        }}
        onSubmit={(url) => {
          if (dialog?.kind === 'link') {
            chain()?.extendMarkRange('link').setLink({ href: url }).run();
          } else {
            const src = videoEmbedUrl(url);
            if (src !== null) {
              chain()?.insertVideo(src).run();
            }
          }
          setDialog(null);
        }}
      />
    </Box>
  );
}

function UrlDialog({
  dialog,
  onClose,
  onSubmit,
}: {
  readonly dialog: Dialog;
  onClose(): void;
  onSubmit(url: string): void;
}): ReactNode {
  const t = useT();
  const id = useId();
  const [url, setUrl] = useState('');
  const video = dialog?.kind === 'video';
  const invalid =
    url.trim() !== '' && (video ? videoEmbedUrl(url) === null : !LINK_TARGET.test(url.trim()));
  const error = invalid
    ? t(video ? 'helpCenter:editor.video.invalid' : 'helpCenter:editor.linkInvalid')
    : undefined;
  const hint = t(video ? 'helpCenter:editor.video.hint' : 'helpCenter:editor.linkHint');

  const close = (): void => {
    setUrl('');
    onClose();
  };

  return (
    <ConfirmDialog
      open={dialog !== null}
      title={t(video ? 'helpCenter:editor.video.title' : 'helpCenter:editor.linkTitle')}
      body={t(video ? 'helpCenter:editor.video.body' : 'helpCenter:editor.linkBody')}
      confirmLabel={t(video ? 'helpCenter:editor.video.insert' : 'helpCenter:editor.linkInsert')}
      confirmDisabled={url.trim() === '' || invalid}
      onClose={close}
      onConfirm={() => {
        onSubmit(url.trim());
        setUrl('');
      }}
    >
      <Field id={id} label={t('helpCenter:editor.url')} hint={hint} error={error}>
        <TextField
          id={id}
          size="small"
          value={url}
          autoFocus
          error={invalid}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
          slotProps={{
            htmlInput: {
              dir: 'ltr',
              inputMode: 'url',
              'aria-invalid': invalid,
              'aria-describedby': fieldDescribedBy(id, { hint, error }),
            },
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}
