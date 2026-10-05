/**
 * The Markdown an article draft is written in (M7-05): paragraphs separated
 * by blank lines, `## ` and `### ` headings, `- ` bullet lists and `**bold**`
 * — what `draftArticleInstructions` asks the model for and what an agent
 * types in the draft box. Rendered to the HTML the help center editor stores.
 *
 * Every character of text is escaped before markup is added, so the output
 * holds only the tags written here. The api still runs it through the
 * article sanitiser on save, as it does any HTML that reaches an article.
 */

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const inline = (text: string): string =>
  escapeHtml(text.trim()).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

const HEADING = /^(#{2,3})\s+(.+)$/;
const BULLET = /^[-*]\s+(.+)$/;

const renderBlock = (block: string): string => {
  const lines = block.split('\n').map((line) => line.trim());
  const heading = lines.length === 1 ? HEADING.exec(lines[0] ?? '') : null;
  if (heading !== null) {
    const level = heading[1]?.length === 3 ? 'h3' : 'h2';
    return `<${level}>${inline(heading[2] ?? '')}</${level}>`;
  }
  if (lines.every((line) => BULLET.test(line))) {
    return `<ul>${lines.map((line) => `<li>${inline(BULLET.exec(line)?.[1] ?? '')}</li>`).join('')}</ul>`;
  }
  return `<p>${lines.map(inline).join('<br>')}</p>`;
};

/** Splits a heading line from the paragraph a model sometimes writes right under it. */
const blocksOf = (markdown: string): string[] =>
  markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^(#{2,3}\s+.+)\n(?!\n)/gm, '$1\n\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '');

export const draftMarkdownToHtml = (markdown: string): string =>
  blocksOf(markdown).map(renderBlock).join('');
