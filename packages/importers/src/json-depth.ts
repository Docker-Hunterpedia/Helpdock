/** Counts nesting outside quoted strings before a recursive validator sees untrusted JSON. */
const MAXIMUM_JSON_DEPTH = 100;

export function withinJsonDepth(json: string): boolean {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of json) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > MAXIMUM_JSON_DEPTH) return false;
    } else if (character === '}' || character === ']') depth -= 1;
  }
  return true;
}
