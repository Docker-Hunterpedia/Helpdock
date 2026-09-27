import { Extension, mergeAttributes, Node } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { CalloutView, VideoView } from './node-views.tsx';

/**
 * The article editor's schema (M5-02, ADR 0001), which mirrors the server's
 * allowlist (`sanitizeArticleHtml`): headings 2 to 4 with an anchor id, lists,
 * links, code blocks, tables, images, callouts and video embeds. ProseMirror
 * drops anything outside it on paste, which keeps what the editor sends close
 * to what the server keeps — the server still sanitises, because a Markdown
 * import or an API caller never passes through here.
 */

/** `id` on headings: what the "Anchor" control sets and a `#fragment` link jumps to. */
export const HeadingAnchor = Extension.create({
  name: 'headingAnchor',
  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          id: {
            default: null,
            parseHTML: (element) => element.getAttribute('id'),
            renderHTML: (attributes) =>
              typeof attributes.id === 'string' && attributes.id !== ''
                ? { id: attributes.id }
                : {},
          },
        },
      },
    ];
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      toggleCallout: () => ReturnType;
    };
    videoEmbed: {
      insertVideo: (src: string) => ReturnType;
    };
  }
}

/** `<div data-callout="tip|caution">`: a tinted box around paragraphs. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'paragraph+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'tip',
        parseHTML: (element) => element.getAttribute('data-callout') ?? 'tip',
        renderHTML: (attributes) => ({ 'data-callout': attributes.kind }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
  addCommands() {
    return {
      toggleCallout:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
    };
  },
  renderMarkdown: (node, helpers) => {
    const kind = String(node.attrs?.kind ?? 'tip').toUpperCase();
    const body = helpers.renderChildren(node.content ?? [], '\n\n');
    return `> [!${kind}]\n${body
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n\n`;
  },
});

/**
 * `<div data-video="https://…">`: the address of an embed from an allowed
 * player. Never an iframe in the stored html; the help center draws the
 * player (`sanitize-article.ts`).
 */
export const VideoEmbed = Node.create({
  name: 'videoEmbed',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-video'),
        renderHTML: (attributes) => ({ 'data-video': attributes.src }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-video]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(VideoView);
  },
  addCommands() {
    return {
      insertVideo:
        (src) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { src } }),
    };
  },
  renderMarkdown: (node) => `[Video](${String(node.attrs?.src ?? '')})\n\n`,
});

export const articleExtensions = () => [
  StarterKit.configure({
    heading: { levels: [2, 3, 4] },
    // Off: it appends an empty paragraph after a closing table or code block,
    // which is a change nobody made, and would autosave an article on open.
    trailingNode: false,
    link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto', 'tel'] },
  }),
  HeadingAnchor,
  Image.configure({ allowBase64: true }),
  TableKit.configure({ table: { resizable: false } }),
  Callout,
  VideoEmbed,
  Markdown,
];
