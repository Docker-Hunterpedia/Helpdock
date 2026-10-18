import { ImportFileError } from './ndjson.js';

/** Detect from the header, so commas and line breaks in message bodies cannot bias it. */
export async function csvDelimiter(text: AsyncGenerator<string>, file: string) {
  let prefix = '';
  let quoted = false;
  const counts = new Map([
    [',', 0],
    [';', 0],
    ['\t', 0],
  ]);
  let complete = false;
  while (!complete) {
    const chunk = await text.next();
    if (chunk.done) break;
    prefix += chunk.value;
    for (const character of chunk.value) {
      if (character === '"') quoted = !quoted;
      if (quoted) continue;
      if (character === '\n' || character === '\r') {
        complete = true;
        break;
      }
      if (counts.has(character)) counts.set(character, (counts.get(character) ?? 0) + 1);
    }
    if (!complete && prefix.length > 4 * 1024 * 1024)
      throw new ImportFileError('line-too-large', file, 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const first = ranked[0];
  if (!first) throw new ImportFileError('invalid-csv-header', file);
  if (first[1] > 0 && ranked[1]?.[1] === first[1])
    throw new ImportFileError('invalid-csv-header', file, 1);
  async function* chunks() {
    yield prefix;
    yield* text;
  }
  return { delimiter: first[0], chunks: chunks() };
}
