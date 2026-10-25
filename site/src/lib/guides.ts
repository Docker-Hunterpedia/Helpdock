/** Takes the guide's `# Title` off its body: the page renders the title itself, as its h1. */
export function splitTitle(markdown: string, fallback: string): { title: string; body: string } {
  const match = /^\s*#[ \t]+(.+?)[ \t]*\n/.exec(markdown);
  if (!match) return { title: fallback, body: markdown };
  return { title: match[1] as string, body: markdown.slice(match[0].length) };
}

// A parenthesis that only cites the plan, such as "(M8-01, REQUIREMENTS §4.11)".
const CITATION = /\s*\((?=[^()]*(?:\bM\d+-\d+\b|§|\bADR\b))[^()]*\)/g;

/** The guide's first paragraph as plain text, cut to fit a meta description. */
export function summarise(body: string, limit = 160): string {
  const paragraph =
    body
      .replace(/<!--[\s\S]*?-->/g, '')
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block !== '' && !/^(#|```|\||<|-\s|\d+\.\s)/.test(block)) ?? '';
  const text = paragraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(CITATION, '')
    // "Specified by REQUIREMENTS §5.1 and …" points at the plan, not the reader's task.
    .replace(/\s*Specified by .*?\.(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const sentence = cut.lastIndexOf('. ');
  if (sentence > limit * 0.6) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}
