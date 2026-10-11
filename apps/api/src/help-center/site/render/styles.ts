import { iconMask, LIGHTBULB_PATHS, TRIANGLE_ALERT_PATHS } from './icons.js';

/**
 * The help center's stylesheet (DESIGN §6.7; artboards `HelpCenter/*`): the
 * page rules, every value a `--hd-*` token or a length on the DESIGN §4
 * scale, every side a logical one so the Arabic page is the English one
 * mirrored. The brand's tokens come before it (`theme.ts`) and its custom
 * CSS after it, both in the same nonce'd `<style>`.
 *
 * The artboards' 10 px and 14 px paddings are drawn at 8 and 12, and their
 * 15 px list text at 16, the nearest steps of the scales (DESIGN change log
 * 1.16).
 */
export const PAGE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--hd-bg-canvas); }
body {
  margin: 0; min-height: 100vh; display: flex; flex-direction: column;
  background: var(--hd-bg-canvas); color: var(--hd-text-primary);
  font-family: var(--hd-font-sans); font-size: 16px; line-height: 24px;
}
:lang(ar) { font-family: var(--hd-font-arabic); letter-spacing: 0; }
a { color: var(--hd-text-link); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: var(--hd-focus-width) var(--hd-focus-style) var(--hd-border-focus); outline-offset: var(--hd-focus-offset); }
h1, h2, h3 { text-wrap: pretty; }
.hd-icon { flex-shrink: 0; }
[dir="rtl"] .hd-mirror { transform: scaleX(-1); }
.hd-sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* The first stop on every page; hidden until it has focus. Its target takes focus without a ring. */
.hd-skip {
  position: absolute; inset-block-start: 8px; inset-inline-start: 8px; z-index: 1; min-block-size: 44px; padding-inline: 16px;
  display: inline-flex; align-items: center; border-radius: var(--hd-radius-md); background: var(--hd-bg-surface);
  color: var(--hd-text-link); font-size: 14px; font-weight: 500; box-shadow: var(--hd-elevation-2);
}
.hd-skip:not(:focus) { inline-size: 1px; block-size: 1px; min-block-size: 0; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
#hd-main:focus { outline: none; }
.hd-muted { color: var(--hd-text-secondary); }
.hd-caption { font-size: 12px; line-height: 16px; color: var(--hd-text-secondary); }

.hd-header {
  min-block-size: 64px; padding-inline: 64px; display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
  border-block-end: 1px solid var(--hd-border-default); background: var(--hd-bg-surface);
}
.hd-brand { display: inline-flex; align-items: center; gap: 8px; color: var(--hd-text-primary); font-weight: 600; min-block-size: 44px; white-space: nowrap; }
.hd-brand:hover { text-decoration: none; }
.hd-mark {
  inline-size: 28px; block-size: 28px; border-radius: var(--hd-radius-md); background: var(--hd-action-primary);
  color: var(--hd-action-primary-text); font-size: 14px; display: inline-flex; align-items: center; justify-content: center;
}
.hd-logo { block-size: 28px; inline-size: auto; max-inline-size: 160px; object-fit: contain; }
.hd-nav { display: flex; flex-wrap: wrap; gap: 20px; font-size: 14px; margin-inline-start: 12px; }
.hd-nav a, .hd-lang, .hd-footer nav a { color: var(--hd-text-secondary); min-block-size: 44px; display: inline-flex; align-items: center; font-size: 14px; }
.hd-nav a[aria-current="page"] { color: var(--hd-text-primary); font-weight: 500; }
.hd-push { margin-inline-start: auto; }
.hd-header-search {
  inline-size: 320px; block-size: 40px; display: flex; align-items: center; gap: 8px; padding-inline: 12px;
  border-radius: var(--hd-radius-md); border: 1px solid var(--hd-border-strong); background: var(--hd-bg-surface); color: var(--hd-text-secondary);
}
.hd-header-search input, .hd-search-field input {
  border: 0; outline: 0; background: transparent; flex-grow: 1; min-inline-size: 0; color: var(--hd-text-primary); font: inherit;
}
.hd-header-search input { font-size: 14px; }
.hd-header-search:focus-within, .hd-search-field:focus-within { border-color: var(--hd-border-focus); outline: var(--hd-focus-width) var(--hd-focus-style) var(--hd-border-focus); outline-offset: var(--hd-focus-offset); }
.hd-label-internal {
  display: inline-flex; align-items: center; gap: 4px; block-size: 24px; padding-inline: 8px; border-radius: var(--hd-radius-md);
  background: var(--hd-status-warning-tint); color: var(--hd-status-warning-text); font-size: 12px; line-height: 16px; font-weight: 500;
}
.hd-staff { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
.hd-avatar {
  inline-size: 28px; block-size: 28px; border-radius: var(--hd-radius-full); background: var(--hd-action-primary-tint);
  color: var(--hd-text-primary); font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; justify-content: center;
}
.hd-inline-form { display: inline; margin: 0; }
.hd-icon-button {
  inline-size: 44px; block-size: 44px; border-radius: var(--hd-radius-md); border: 0; background: transparent; color: var(--hd-text-secondary);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
}
.hd-icon-button:hover { background: var(--hd-bg-muted); }

.hd-preview {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding-block: 12px; padding-inline: 64px; font-size: 14px; line-height: 20px;
  background: var(--hd-status-warning-tint); color: var(--hd-status-warning-text); border-block-end: 1px solid var(--hd-status-warning);
}
.hd-preview.hd-preview-info { background: var(--hd-status-info-tint); color: var(--hd-status-info-text); border-block-end-color: var(--hd-status-info); }
.hd-preview span { flex-grow: 1; }
.hd-preview a { color: inherit; text-decoration: underline; display: inline-flex; align-items: center; gap: 4px; min-block-size: 44px; }

.hd-button, .hd-button-secondary {
  block-size: 40px; padding-inline: 16px; border-radius: var(--hd-radius-md); font: inherit; font-size: 14px; font-weight: 500;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; white-space: nowrap; cursor: pointer;
  transition: background-color var(--hd-duration-fast) var(--hd-ease-out);
}
.hd-button { border: 0; background: var(--hd-action-primary); color: var(--hd-action-primary-text); }
.hd-button:hover { background: var(--hd-action-primary-hover); text-decoration: none; }
.hd-button:active { background: var(--hd-action-primary-active); }
.hd-button:disabled { background: var(--hd-bg-muted); color: var(--hd-text-secondary); cursor: not-allowed; }
.hd-button-secondary { border: 1px solid var(--hd-border-strong); background: var(--hd-bg-surface); color: var(--hd-text-primary); }
.hd-button-secondary:hover { background: var(--hd-bg-muted); text-decoration: none; }
.hd-button-ghost {
  block-size: 40px; padding-inline: 16px; border-radius: var(--hd-radius-md); font-size: 14px; font-weight: 500;
  display: inline-flex; align-items: center; justify-content: center; color: var(--hd-text-secondary);
}
.hd-button-ghost:hover { background: var(--hd-bg-muted); text-decoration: none; }
.hd-button-lg { block-size: 48px; padding-inline: 20px; font-size: 16px; }

.hd-hero {
  padding-block: 64px 48px; padding-inline: 64px; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
  border-block-end: 1px solid var(--hd-border-default);
}
.hd-display { margin: 0; font-size: 32px; line-height: 40px; font-weight: 600; }
.hd-search { display: flex; gap: 8px; inline-size: 100%; max-inline-size: 720px; }
.hd-hero .hd-search { margin-block-start: 16px; max-inline-size: 640px; }
.hd-search-field {
  flex-grow: 1; min-inline-size: 0; display: flex; align-items: center; gap: 12px; block-size: 48px; padding-inline: 16px;
  border-radius: var(--hd-radius-md); border: 1px solid var(--hd-border-strong); background: var(--hd-bg-surface); color: var(--hd-text-secondary);
}
.hd-search-field input { font-size: 16px; }
.hd-clear { inline-size: 28px; block-size: 28px; border-radius: var(--hd-radius-md); color: var(--hd-text-secondary); display: inline-flex; align-items: center; justify-content: center; }

.hd-main { flex-grow: 1; inline-size: 100%; max-inline-size: 1280px; margin-inline: auto; padding-block: 48px; padding-inline: 64px; display: flex; flex-direction: column; gap: 48px; }
.hd-page { flex-grow: 1; inline-size: 100%; max-inline-size: 1280px; margin-inline: auto; padding-block: 40px 48px; padding-inline: 64px; display: grid; gap: 48px; }
.hd-page-2 { grid-template-columns: minmax(0, 1fr) 240px; }
.hd-page-3 { grid-template-columns: 240px minmax(0, 1fr) 240px; }
.hd-stack { display: flex; flex-direction: column; gap: 16px; min-inline-size: 0; }
.hd-stack-lg { display: flex; flex-direction: column; gap: 24px; min-inline-size: 0; }
.hd-h2 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
.hd-row { display: flex; align-items: baseline; gap: 16px; }
.hd-row-center { align-items: center; }
.hd-gap-4 { gap: 4px; }
.hd-gap-8 { gap: 8px; }
.hd-gap-12 { gap: 12px; }
.hd-gap-16 { gap: 16px; }
.hd-gap-20 { gap: 20px; }
.hd-gap-24 { gap: 24px; }
.hd-offset-32 { padding-block-start: 32px; }
.hd-offset-64 { padding-block-start: 64px; }
.hd-h3 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.hd-card-text { font-size: 14px; line-height: 20px; color: var(--hd-text-secondary); }
.hd-more { font-size: 14px; line-height: 20px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px; min-block-size: 44px; }
.hd-plain-link { color: inherit; }
.hd-side-nav a.hd-link { color: var(--hd-text-link); }
.hd-grow { flex-grow: 1; }

.hd-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.hd-cards-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.hd-cards-1 { grid-template-columns: minmax(0, 1fr); }
.hd-card {
  display: flex; flex-direction: column; gap: 8px; padding: 20px; border-radius: var(--hd-radius-lg);
  border: 1px solid var(--hd-border-default); background: var(--hd-bg-surface); color: var(--hd-text-primary); align-self: start;
}
a.hd-card:hover { text-decoration: none; border-color: var(--hd-border-strong); }
.hd-card-title { display: flex; align-items: center; gap: 12px; font-weight: 600; }
.hd-tile {
  inline-size: 36px; block-size: 36px; border-radius: var(--hd-radius-md); background: var(--hd-bg-muted); color: var(--hd-action-primary);
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.hd-tile-lg { inline-size: 48px; block-size: 48px; border-radius: var(--hd-radius-lg); }

.hd-list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--hd-border-default); border-radius: var(--hd-radius-lg); background: var(--hd-bg-surface); }
.hd-list li { display: flex; align-items: center; gap: 12px; padding-block: 12px; padding-inline: 16px; }
.hd-list li + li { border-block-start: 1px solid var(--hd-bg-muted); }
.hd-list a { flex-grow: 1; }
.hd-rank { inline-size: 20px; font-family: var(--hd-font-mono); font-size: 13px; color: var(--hd-text-secondary); }
.hd-plain-list { margin: 0; padding: 0; list-style: none; }
.hd-plain-list li { display: flex; align-items: center; gap: 8px; padding-block: 8px; }
.hd-plain-list li + li { border-block-start: 1px solid var(--hd-bg-muted); }

.hd-help { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 24px; border-radius: var(--hd-radius-lg); border: 1px solid var(--hd-border-default); background: var(--hd-bg-surface); }
.hd-help-text { display: flex; flex-direction: column; gap: 2px; flex-grow: 1; min-inline-size: 240px; }
.hd-help-text p, .hd-aside-card p { margin: 0; font-size: 14px; line-height: 20px; color: var(--hd-text-secondary); }
.hd-aside { display: flex; flex-direction: column; gap: 24px; }
.hd-aside-card { padding: 16px; border-radius: var(--hd-radius-lg); background: var(--hd-bg-surface); border: 1px solid var(--hd-border-default); display: flex; flex-direction: column; gap: 8px; }
.hd-aside-card .hd-title { font-weight: 600; }
.hd-aside-card > a:not(.hd-button) { font-size: 14px; line-height: 20px; text-align: center; min-block-size: 44px; display: inline-flex; align-items: center; justify-content: center; }
.hd-side-nav { display: flex; flex-direction: column; gap: 4px; font-size: 14px; line-height: 20px; }
.hd-side-nav a { padding-block: 8px; padding-inline: 8px; border-radius: var(--hd-radius-md); color: var(--hd-text-secondary); display: flex; align-items: center; gap: 8px; }
.hd-side-nav a[aria-current] { background: var(--hd-bg-muted); color: var(--hd-text-primary); font-weight: 500; }
.hd-side-heading { padding-inline: 8px; padding-block-end: 8px; font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--hd-text-secondary); }
:lang(ar) .hd-side-heading { letter-spacing: 0; text-transform: none; }
.hd-count { font-family: var(--hd-font-mono); font-size: 12px; color: var(--hd-text-secondary); }

.hd-breadcrumb { font-size: 13px; line-height: 20px; color: var(--hd-text-secondary); }
.hd-breadcrumb ol { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.hd-breadcrumb li { display: inline-flex; align-items: center; gap: 8px; }
.hd-breadcrumb a { color: var(--hd-text-secondary); }
.hd-breadcrumb [aria-current] { color: var(--hd-text-primary); }
.hd-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 13px; line-height: 20px; color: var(--hd-text-secondary); }
.hd-dot { inline-size: 4px; block-size: 4px; border-radius: var(--hd-radius-full); background: var(--hd-border-strong); }
.hd-lead { margin: 0; color: var(--hd-text-secondary); max-inline-size: 68ch; }
.hd-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--hd-status-warning-text); white-space: nowrap; }

.hd-article { display: flex; flex-direction: column; gap: 20px; max-inline-size: 680px; min-inline-size: 0; }
.hd-note {
  display: flex; gap: 12px; padding-block: 12px; padding-inline: 16px; border-radius: var(--hd-radius-lg); font-size: 14px; line-height: 20px;
  background: var(--hd-status-info-tint); border: 1px solid var(--hd-status-info); color: var(--hd-status-info-text);
}
.hd-note a { color: inherit; text-decoration: underline; }
.hd-note-body { display: flex; flex-direction: column; gap: 4px; }
.hd-body { display: flex; flex-direction: column; gap: 20px; font-size: 16px; line-height: 24px; }
/* A link inside a sentence is underlined: in dark mode the link colour is under 3:1 against the text around it. */
.hd-body a { text-decoration: underline; text-underline-offset: 2px; }
.hd-body > * { margin: 0; }
.hd-body p, .hd-body li { max-inline-size: 68ch; text-wrap: pretty; }
.hd-body h2 { margin-block-start: 8px; font-size: 20px; line-height: 28px; font-weight: 600; }
.hd-body h3, .hd-body h4 { margin-block-start: 8px; font-size: 16px; line-height: 24px; font-weight: 600; }
.hd-body ul, .hd-body ol { padding-inline-start: 24px; display: flex; flex-direction: column; gap: 8px; }
.hd-body blockquote { padding-inline-start: 16px; border-inline-start: 2px solid var(--hd-border-strong); color: var(--hd-text-secondary); }
.hd-body img { max-inline-size: 100%; block-size: auto; border-radius: var(--hd-radius-md); }
.hd-body hr { border: 0; border-block-start: 1px solid var(--hd-border-default); }
.hd-body table {
  border-collapse: separate; border-spacing: 0; inline-size: 100%; font-size: 14px; line-height: 20px;
  border: 1px solid var(--hd-border-default); border-radius: var(--hd-radius-lg); background: var(--hd-bg-surface); overflow: hidden;
}
.hd-body th, .hd-body td { padding-block: 8px; padding-inline: 12px; text-align: start; vertical-align: top; }
.hd-body th { background: var(--hd-bg-muted); font-weight: 500; }
.hd-body tr + tr td, .hd-body tbody tr:first-child td { border-block-start: 1px solid var(--hd-bg-muted); }
.hd-body code { font-family: var(--hd-font-mono); font-size: 13px; background: var(--hd-bg-muted); border-radius: var(--hd-radius-sm); padding-inline: 4px; }
.hd-body pre {
  direction: ltr; text-align: start; padding-block: 12px; padding-inline: 16px; border-radius: var(--hd-radius-md);
  background: var(--hd-bg-muted); font-family: var(--hd-font-mono); font-size: 14px; line-height: 20px; overflow-x: auto;
}
.hd-body pre code { padding: 0; background: transparent; font-size: inherit; }
.hd-body [data-callout] {
  position: relative; padding-block: 12px; padding-inline: 48px 16px; border-radius: var(--hd-radius-lg); font-size: 16px; line-height: 24px;
  background: var(--hd-action-primary-tint); border: 1px solid var(--hd-action-primary-tint);
}
.hd-body [data-callout]::before {
  content: ''; position: absolute; inset-inline-start: 16px; inset-block-start: 16px; inline-size: 16px; block-size: 16px;
  background: var(--hd-action-primary); mask: ${iconMask(LIGHTBULB_PATHS)} center / contain no-repeat;
}
.hd-body [data-callout="caution"] { background: var(--hd-status-warning-tint); border-color: var(--hd-status-warning); }
.hd-body [data-callout="caution"]::before { background: var(--hd-status-warning-text); mask-image: ${iconMask(TRIANGLE_ALERT_PATHS)}; }
.hd-body [data-callout] > * { margin: 0; }
.hd-video { position: relative; aspect-ratio: 16 / 9; border-radius: var(--hd-radius-lg); overflow: hidden; background: var(--hd-bg-muted); }
.hd-video iframe { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; border: 0; }
/* Focus is inside the third-party player, so the box around it draws the ring. */
.hd-video:focus-within { outline: var(--hd-focus-width) var(--hd-focus-style) var(--hd-border-focus); outline-offset: var(--hd-focus-offset); }

.hd-feedback { margin-block-start: 8px; padding: 16px; border-radius: var(--hd-radius-lg); border: 1px solid var(--hd-border-default); background: var(--hd-bg-surface); display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 14px; }
.hd-feedback fieldset { margin: 0; padding: 0; border: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; inline-size: 100%; }
.hd-feedback legend { float: inline-start; padding: 0; margin-inline-end: auto; }
.hd-feedback .hd-button-secondary, .hd-feedback .hd-button, .hd-feedback .hd-button-ghost { block-size: 44px; }
/* 2 px, not 1: forced colours keep a border's width and drop its colour and the tint, so width is what tells the pressed answer apart. */
.hd-feedback [aria-pressed="true"] { border-width: 2px; border-color: var(--hd-text-primary); background: var(--hd-bg-muted); }
.hd-feedback-comment { flex-direction: column; align-items: stretch; }
.hd-feedback-label { font-weight: 500; }
.hd-feedback textarea {
  inline-size: 100%; padding-block: 8px; padding-inline: 12px; border-radius: var(--hd-radius-md); border: 1px solid var(--hd-border-strong);
  background: var(--hd-bg-surface); color: var(--hd-text-primary); font: inherit; font-size: 14px; line-height: 20px; resize: vertical;
}
.hd-feedback textarea:focus-visible { border-color: var(--hd-border-focus); }
.hd-feedback-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.hd-feedback-actions .hd-caption { flex: 1 1 240px; }
.hd-feedback-done { color: var(--hd-text-primary); }
.hd-feedback-done svg { color: var(--hd-status-success); }

.hd-state { flex-grow: 1; inline-size: 100%; max-inline-size: 720px; margin-inline: auto; padding-block: 64px; padding-inline: 16px; display: flex; flex-direction: column; align-items: flex-start; gap: 24px; }
.hd-state .hd-tile-lg { color: var(--hd-text-secondary); }
.hd-state-links { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; font-size: 14px; }
.hd-state-links a { min-block-size: 44px; display: inline-flex; align-items: center; gap: 4px; }
.hd-state .hd-search { max-inline-size: 100%; }

.hd-results { margin: 0; padding-block: 0; padding-inline: 20px; list-style: none; border: 1px solid var(--hd-border-default); border-radius: var(--hd-radius-lg); background: var(--hd-bg-surface); }
.hd-results li { display: flex; flex-direction: column; gap: 4px; padding-block: 16px; }
.hd-results li + li { border-block-start: 1px solid var(--hd-border-default); }
.hd-results h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.hd-results p { margin: 0; font-size: 14px; line-height: 20px; color: var(--hd-text-secondary); max-inline-size: 760px; }
.hd-trail { display: flex; align-items: center; gap: 4px; font-size: 13px; line-height: 20px; color: var(--hd-text-secondary); }
mark { background: var(--hd-status-warning-tint); color: var(--hd-text-primary); border-radius: var(--hd-radius-sm); padding-inline: 2px; }
.hd-status { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 20px; color: var(--hd-text-secondary); }
.hd-empty { display: flex; gap: 16px; align-items: flex-start; }
.hd-chips { margin-block-start: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; line-height: 20px; color: var(--hd-text-secondary); }
.hd-chip {
  min-block-size: 32px; padding-inline: 12px; border-radius: var(--hd-radius-md); border: 1px solid var(--hd-border-strong);
  background: var(--hd-bg-surface); color: var(--hd-text-primary); display: inline-flex; align-items: center;
}

.hd-footer {
  padding-block: 24px; padding-inline: 64px; display: flex; flex-wrap: wrap; align-items: center; gap: 24px; font-size: 14px; line-height: 20px;
  border-block-start: 1px solid var(--hd-border-default); background: var(--hd-bg-surface);
}
.hd-footer-brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.hd-footer-brand .hd-mark { inline-size: 20px; block-size: 20px; border-radius: var(--hd-radius-sm); font-size: 12px; }
.hd-footer nav { display: flex; flex-wrap: wrap; gap: 20px; }

@media (max-width: 1024px) {
  .hd-page-2, .hd-page-3 { grid-template-columns: minmax(0, 1fr); }
  .hd-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hd-header-search { inline-size: 100%; order: 3; }
}
@media (max-width: 720px) {
  .hd-header, .hd-hero, .hd-main, .hd-page, .hd-footer, .hd-preview { padding-inline: 16px; }
  .hd-cards, .hd-cards-2 { grid-template-columns: minmax(0, 1fr); }
  .hd-nav { margin-inline-start: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .hd-button, .hd-button-secondary { transition: none; }
}
`;
