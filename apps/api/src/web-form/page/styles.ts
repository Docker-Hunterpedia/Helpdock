import { tokensCssBundle } from '@helpdock/ui/css';

/**
 * The public form's stylesheet (artboards `WebFormEN`, `WebFormAR`): the
 * DESIGN tokens as `--hd-*` custom properties, light and dark, then the few
 * rules the page needs, every length on the DESIGN §4 scale and every side a
 * logical one so the Arabic page is the English page mirrored.
 *
 * It is inlined under the response's CSP nonce rather than served as a file:
 * one request fewer for a page a customer opens once, and nothing to cache
 * across a deploy that changed it.
 */
const PAGE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--hd-bg-canvas); }
body {
  margin: 0; min-height: 100vh; background: var(--hd-bg-canvas); color: var(--hd-text-primary);
  font-family: var(--hd-font-sans); font-size: 16px; line-height: 24px;
}
:lang(ar) body, body:lang(ar) { font-family: var(--hd-font-arabic); letter-spacing: 0; }
a { color: var(--hd-text-link); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: var(--hd-focus-width) var(--hd-focus-style) var(--hd-border-focus); outline-offset: var(--hd-focus-offset); }
.mono { font-family: var(--hd-font-mono); }
.hd-header {
  min-height: 64px; padding-inline: 64px; display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
  border-block-end: 1px solid var(--hd-border-default); background: var(--hd-bg-surface);
}
.hd-brand { display: inline-flex; align-items: center; gap: 12px; color: var(--hd-text-primary); font-weight: 600; min-height: 44px; }
.hd-mark {
  inline-size: 28px; block-size: 28px; border-radius: var(--hd-radius-md); background: var(--hd-action-primary);
  color: var(--hd-action-primary-text); font-size: 14px; display: inline-flex; align-items: center; justify-content: center;
}
.hd-nav { display: flex; gap: 20px; font-size: 14px; margin-inline-start: auto; }
.hd-nav a, .hd-lang { color: var(--hd-text-secondary); min-height: 44px; display: inline-flex; align-items: center; font-size: 14px; }
.hd-nav a[aria-current="page"] { color: var(--hd-text-primary); font-weight: 500; }
.hd-main { max-inline-size: 1280px; margin-inline: auto; padding-block: 32px; padding-inline: 64px; }
.hd-card {
  max-inline-size: 720px; display: flex; flex-direction: column; gap: 16px; padding-block: 24px; padding-inline: 32px;
  border-radius: var(--hd-radius-lg); background: var(--hd-bg-surface); border: 1px solid var(--hd-border-default);
}
.hd-card h1 { margin: 0; font-size: 24px; line-height: 32px; font-weight: 600; text-wrap: pretty; }
.hd-card h2 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; text-wrap: pretty; }
.hd-lead, .hd-secondary { margin: 0; color: var(--hd-text-secondary); }
.hd-intro { display: flex; flex-direction: column; gap: 4px; }
.hd-banner {
  display: flex; gap: 8px; padding-block: 12px; padding-inline: 16px; border-radius: var(--hd-radius-md);
  font-size: 14px; line-height: 20px;
}
.hd-banner-danger { background: var(--hd-status-danger-tint); border: 1px solid var(--hd-status-danger); color: var(--hd-status-danger-text); }
.hd-banner-success { background: var(--hd-status-success-tint); border: 1px solid var(--hd-status-success); color: var(--hd-status-success-text); }
.hd-banner svg { flex-shrink: 0; margin-block-start: 2px; }
.hd-banner-body { display: flex; flex-direction: column; gap: 4px; }
.hd-banner-title { font-weight: 600; }
.hd-banner-links { display: flex; gap: 16px; flex-wrap: wrap; }
.hd-banner-links a { color: inherit; text-decoration: underline; }
.hd-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.hd-wide { grid-column: 1 / -1; }
.hd-field { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; border: 0; min-inline-size: 0; }
.hd-label { font-size: 14px; line-height: 20px; font-weight: 500; padding: 0; }
.hd-label span { font-weight: 400; color: var(--hd-text-secondary); }
.hd-input {
  block-size: 44px; inline-size: 100%; padding-inline: 12px; border-radius: var(--hd-radius-md);
  border: 1px solid var(--hd-border-strong); background: var(--hd-bg-surface); color: var(--hd-text-primary);
  font: inherit; font-size: 16px; transition: border-color var(--hd-duration-fast) var(--hd-ease-out);
}
textarea.hd-input { block-size: auto; min-block-size: 120px; padding-block: 8px; resize: vertical; }
select.hd-input { appearance: auto; }
.hd-input:focus { border-color: var(--hd-border-focus); }
.hd-input[aria-invalid="true"] { border-color: var(--hd-status-danger); }
.hd-check { display: flex; align-items: center; gap: 8px; min-block-size: 44px; font-size: 16px; }
.hd-check input { inline-size: 16px; block-size: 16px; margin: 0; accent-color: var(--hd-action-primary); }
.hd-hint { margin: 0; font-size: 12px; line-height: 16px; color: var(--hd-text-secondary); }
.hd-error { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--hd-status-danger-text); }
.hd-file { font: inherit; font-size: 14px; color: var(--hd-text-secondary); max-inline-size: 100%; }
.hd-file::file-selector-button {
  block-size: 44px; padding-inline: 16px; margin-inline-end: 12px; border-radius: var(--hd-radius-md);
  border: 1px solid var(--hd-border-strong); background: var(--hd-bg-surface); color: var(--hd-text-primary);
  font: inherit; font-size: 16px; font-weight: 500; cursor: pointer;
}
.hd-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.hd-captcha { min-block-size: 64px; }
.hd-button {
  block-size: 44px; padding-inline: 24px; border-radius: var(--hd-radius-md); border: 0; cursor: pointer;
  background: var(--hd-action-primary); color: var(--hd-action-primary-text); font: inherit; font-size: 16px; font-weight: 500;
  margin-inline-start: auto; transition: background-color var(--hd-duration-fast) var(--hd-ease-out);
}
.hd-button:hover { background: var(--hd-action-primary-hover); }
.hd-button:active { background: var(--hd-action-primary-active); }
.hd-links { display: flex; gap: 16px; flex-wrap: wrap; }
.hd-links a { min-block-size: 44px; display: inline-flex; align-items: center; font-size: 14px; }
.hd-hp { display: none; }
@media (max-width: 720px) {
  .hd-header, .hd-main { padding-inline: 16px; }
  .hd-card { padding-inline: 16px; }
  .hd-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .hd-input, .hd-button { transition: none; }
}
`;

export const pageStylesheet = (): string => `${tokensCssBundle()}\n${PAGE_CSS}`;
