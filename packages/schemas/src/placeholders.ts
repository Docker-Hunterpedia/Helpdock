/**
 * Filling `{{contact.first_name}}` in a ticket template (M1-06) or a canned
 * response (M3-06). Pure, so the api renders with it and the admin's editor
 * previews with the very same rules.
 *
 * **It resolves a fixed list of names, not a path into an object.** A renderer
 * that walked properties would answer `{{constructor.constructor}}` with a
 * function and `{{__proto__}}` with an object. The values are a `Map` the
 * caller built, so a placeholder either is one of them or is not, and "is not"
 * leaves the text exactly as it was written — an author who typed
 * `{{contcat.name}}` sees their typo instead of a customer reading a hole.
 *
 * **One pass.** The replacement is a function, so a value that happens to
 * contain `{{…}}` is inserted literally and never expanded, and `$&` in a value
 * is not read as a replacement pattern.
 */

/**
 * A placeholder as a text may write it: `{{ name }}` with optional spaces, one
 * or two dotted segments. Anything else is not a placeholder and is left alone.
 */
const PLACEHOLDER = /\{\{\s*([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\}\}/gi;

/**
 * The first whitespace-separated word of a name, and the rest. A single-word
 * name is a first name with no last name, which reads correctly far more often
 * than the alternatives.
 */
export const splitName = (name: string): { first: string; last: string } => {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
};

export interface RenderedTemplate {
  readonly text: string;
  /** Placeholders the text uses that the values could not fill, once each, in order. */
  readonly unknown: readonly string[];
}

/** `text` with every placeholder `values` knows replaced, and the rest untouched. */
export const renderTemplate = (
  text: string,
  values: ReadonlyMap<string, string>,
): RenderedTemplate => {
  const segments = renderSegments(text, values);

  return {
    text: segments.segments.map((segment) => segment.text).join(''),
    unknown: segments.unknown,
  };
};

/** One run of rendered text, and the placeholder it came from when it came from one. */
export interface RenderedSegment {
  readonly text: string;
  readonly placeholder: string | null;
}

export interface RenderedSegments {
  readonly segments: readonly RenderedSegment[];
  readonly unknown: readonly string[];
}

/**
 * The same rendering as {@link renderTemplate}, kept in runs so a screen can
 * mark which words came from a placeholder (the composer's picker highlights
 * them) without parsing the result a second time.
 */
export const renderSegments = (
  text: string,
  values: ReadonlyMap<string, string>,
): RenderedSegments => {
  const unknown = new Set<string>();
  const segments: RenderedSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(PLACEHOLDER)) {
    const [whole, name = ''] = match;
    const key = name.toLowerCase();
    const value = values.get(key);
    const at = match.index;

    if (at > cursor) {
      segments.push({ text: text.slice(cursor, at), placeholder: null });
    }
    if (value === undefined) {
      unknown.add(key);
      segments.push({ text: whole, placeholder: null });
    } else {
      segments.push({ text: value, placeholder: key });
    }
    cursor = at + whole.length;
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), placeholder: null });
  }

  return { segments, unknown: [...unknown] };
};

// --------------------------------------------------------------------------
// The sender as a customer meets them (M14-12)
// --------------------------------------------------------------------------

/**
 * The placeholders that describe the person sending a reply and the desk they
 * answer for. `agent.first_name` predates them and stays in the canned list
 * beside these; it is the first word of the full name, whereas `agent.name` is
 * what the person chose to be called.
 */
export const AGENT_PLACEHOLDERS = [
  'agent.name',
  'agent.full_name',
  'agent.title',
  'agent.phone',
  'department.name',
] as const;
export type AgentPlaceholder = (typeof AGENT_PLACEHOLDERS)[number];

/** The language a customer reads a reply in. */
export type ReplyLanguage = 'en' | 'ar';

/** What `users` holds about how a person appears; every field but the full name may be unset. */
export interface AgentIdentity {
  readonly fullName: string;
  readonly publicName?: string | null | undefined;
  readonly jobTitleEn?: string | null | undefined;
  readonly jobTitleAr?: string | null | undefined;
  readonly phone?: string | null | undefined;
}

const filled = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';

  return trimmed === '' ? null : trimmed;
};

/**
 * The name a customer sees: the public name when one is set, otherwise the
 * first word of the full name, which is what every customer surface showed
 * before the public name existed.
 */
export const publicNameOf = (identity: AgentIdentity): string =>
  filled(identity.publicName) ?? splitName(identity.fullName).first;

/**
 * The job title in the language of the reply. An Arabic reply from someone with
 * no Arabic title says the English one rather than nothing; null when neither
 * is set.
 */
export const jobTitleFor = (identity: AgentIdentity, language: ReplyLanguage): string | null => {
  const english = filled(identity.jobTitleEn);

  return language === 'ar' ? (filled(identity.jobTitleAr) ?? english) : english;
};

/**
 * The values of {@link AGENT_PLACEHOLDERS}. Each is present even when empty, so
 * an unset title or phone renders as nothing and not as the placeholder spelled
 * out, which is what a customer would otherwise read.
 */
export const agentPlaceholderValues = (
  identity: AgentIdentity,
  language: ReplyLanguage,
  departmentName: string | null,
): ReadonlyMap<AgentPlaceholder, string> =>
  new Map<AgentPlaceholder, string>([
    ['agent.name', publicNameOf(identity)],
    ['agent.full_name', identity.fullName],
    ['agent.title', jobTitleFor(identity, language) ?? ''],
    ['agent.phone', filled(identity.phone) ?? ''],
    ['department.name', departmentName ?? ''],
  ]);

/** Separators a line may be left holding at its ends once a placeholder in it rendered empty. */
const DANGLING = /^[\s·|/,\-–—]+|[\s·|/,\-–—]+$/gu;

/**
 * A signature with its placeholders filled, one line at a time.
 *
 * A line that held a placeholder and came out empty is dropped, and one that
 * came out with a separator hanging off it (`" · Helpdock"`, from an unset
 * title) loses the separator, so a person without a phone number has no blank
 * line where it would have been. A line without placeholders is kept as typed,
 * and so are the blank lines a person left on purpose.
 */
export const renderSignature = (text: string, values: ReadonlyMap<string, string>): string =>
  text
    .split(/\r?\n/u)
    .flatMap((line) => {
      if (!line.includes('{{')) {
        return [line];
      }
      const rendered = renderTemplate(line, values).text;
      const tidy = rendered === line ? rendered : rendered.replace(DANGLING, '');

      return tidy.trim() === '' ? [] : [tidy];
    })
    .join('\n');
