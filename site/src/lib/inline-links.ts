/**
 * Copy can carry `[label](href)` links. Pages render them as anchors; JSON-LD
 * and meta tags take the plain text.
 */
export type Piece = { text: string; href?: string };

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function splitLinks(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    if (match.index > last) pieces.push({ text: text.slice(last, match.index) });
    pieces.push({ text: match[1] as string, href: match[2] as string });
    last = match.index + match[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });
  return pieces;
}

export function plainText(text: string): string {
  return text.replace(LINK, '$1');
}
