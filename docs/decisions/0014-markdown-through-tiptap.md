# 14. Markdown import and export through `@tiptap/markdown`

Date: 2026-09-27 · Status: accepted · Deliverable: M5-02

## Context

[REQUIREMENTS §4.5](../planning/REQUIREMENTS.md#45-help-center) asks for
"Markdown import/export" in the article editor.
[ADR 0001](0001-tiptap-for-rich-text.md) chose TipTap for that editor and named
the MIT packages it would use — core, React, the starter kit, tables, images —
but not a Markdown converter, and the stack table in
[ARCHITECTURE §1](../planning/ARCHITECTURE.md#1-stack-at-a-glance) names none.

Import and export have to agree with the editor's own schema: a Markdown file
turned into nodes the editor does not have would be dropped on the way in, and
an export that does not know the editor's tables or code blocks would lose them
on the way out.

## Options

**A general-purpose converter (`marked` plus `turndown`, or `remark`).** Two
libraries, one each way, neither of which knows the editor's schema. Every node
we add — the callout, the video embed — would need a rule in each, written
twice and kept in step with the TipTap node by hand.

**Write one.** A Markdown parser is not a small thing to own; tables and nested
lists alone are the bulk of the CommonMark and GFM specifications.

**`@tiptap/markdown` (3.31.3, MIT).** TipTap's own Markdown extension, from the
same public registry and under the same licence as the packages ADR 0001
adopted. It parses Markdown into the editor's schema and serialises the
document back, and a node declares how it is written (`renderMarkdown`) next to
its html, so the callout and the video embed describe themselves once. It uses
`marked` for tokenising.

## Decision

`@tiptap/markdown@3.31.3`, pinned exactly with the other TipTap packages, as a
dependency of `apps/admin`. Import and export run **in the browser**:
"Import .md" replaces the current language's text with the parsed file, and
the result is saved like any other edit — through `PUT …/versions/:locale`,
where the server sanitises it against the article allowlist
(`sanitizeArticleHtml`, ADR 0007). The server never parses Markdown, so there
is no second path into stored html.

Our two nodes write themselves as follows, and are read back as their nearest
Markdown equivalent:

- a callout as a GitHub alert, `> [!TIP]` or `> [!CAUTION]`, which reads back
  as a blockquote;
- a video embed as a link, `[Video](https://www.youtube-nocookie.com/embed/…)`,
  which reads back as a link.

## Consequences

- One more MIT package from the same upstream, loaded only on the editor's
  split route, so the admin's other screens do not pay for it (ADR 0001).
- A round trip through Markdown is lossy for callouts and videos, which become
  a blockquote and a link. That is the honest reading of a format that has no
  such blocks; the note under the buttons says import replaces the text.
- If the server ever needs Markdown (an API that accepts it), it takes a
  converter of its own and an ADR; this one does not decide that.
