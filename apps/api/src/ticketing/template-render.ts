import { TEMPLATE_PLACEHOLDERS, type TemplatePlaceholder } from '@helpdock/schemas';

/**
 * Filling `{{contact.first_name}}` in a ticket template (M1-06).
 *
 * **It resolves a fixed list of names, not a path into an object.** That is the
 * whole design. A renderer that walked properties would answer
 * `{{constructor.constructor}}` with a function, `{{__proto__}}` with an
 * object, and — in the shape people reach for first, `path.split('.').reduce(…)`
 * over the context — would hand a template author a way to read anything
 * reachable from the object they were given. The names below are a `Map` built
 * from values the caller passed in, so a placeholder either is one of them or
 * is not, and "is not" leaves the text exactly as it was written.
 *
 * **Leaving it alone is the right failure.** An author who typed
 * `{{contcat.name}}` sees their typo in the preview. Replacing it with an empty
 * string would hide it until a customer read the sentence with a hole in it.
 *
 * **One pass.** The replacement is a function, so a value that happens to
 * contain `{{…}}` — a contact whose name really is `{{admin}}` — is inserted
 * literally and never expanded. There is no second pass for it to be found in.
 */

/**
 * A placeholder as a template may write it: `{{ name }}` with optional spaces,
 * one or two dotted segments. Anything else — `{{a.b.c}}`, `{{a-b}}` — is not a
 * placeholder and is left alone by the same rule as an unknown one.
 */
const PLACEHOLDER = /\{\{\s*([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\}\}/gi;

/** What a caller knows about the ticket a template is being filled for. */
export interface TemplateSubject {
  readonly brand: { readonly name: string };
  /** Absent leaves every `contact.*` placeholder spelled out. */
  readonly contact?: { readonly name: string; readonly email: string | null } | undefined;
  /** Absent leaves `{{ticket.number}}` spelled out, which a preview has to. */
  readonly ticket?: { readonly number: string } | undefined;
}

/**
 * The first whitespace-separated word of a name, and the rest.
 *
 * A single-word name is a first name with no last name, which is right far more
 * often than the alternatives: "Mona" greeted as "Mona" reads correctly, and
 * "Hi {{contact.last_name}}" with nothing after it is a sentence nobody sends
 * twice.
 */
export const splitName = (name: string): { first: string; last: string } => {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
};

/**
 * The names this subject can fill, as a `Map`. A `Map` rather than an object
 * literal because it has no prototype to inherit `constructor` or `toString`
 * from: `values.get('constructor')` is `undefined`, where `values.constructor`
 * would not be.
 */
export const templateValues = (subject: TemplateSubject): ReadonlyMap<string, string> => {
  const values = new Map<TemplatePlaceholder, string>();

  values.set('brand.name', subject.brand.name);

  if (subject.contact !== undefined) {
    const { first, last } = splitName(subject.contact.name);
    values.set('contact.name', subject.contact.name);
    values.set('contact.first_name', first);
    values.set('contact.last_name', last);
    values.set('contact.email', subject.contact.email ?? '');
  }

  if (subject.ticket !== undefined) {
    values.set('ticket.number', subject.ticket.number);
  }

  return values;
};

export interface RenderedTemplate {
  readonly text: string;
  /**
   * Placeholders the text uses that the subject could not fill, in the order
   * they appear and without repeats. The preview shows them so an author can
   * tell a typo from a value that is merely empty.
   */
  readonly unknown: readonly string[];
}

/** Whether a name is one this renderer would ever fill, whatever the subject. */
export const isTemplatePlaceholder = (name: string): name is TemplatePlaceholder =>
  (TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name);

/** `text` with every placeholder `values` knows replaced, and the rest untouched. */
export const renderTemplate = (
  text: string,
  values: ReadonlyMap<string, string>,
): RenderedTemplate => {
  const unknown = new Set<string>();

  const rendered = text.replace(PLACEHOLDER, (match, name: string) => {
    const key = name.toLowerCase();
    const value = values.get(key);
    if (value === undefined) {
      unknown.add(key);
      return match;
    }

    return value;
  });

  return { text: rendered, unknown: [...unknown] };
};

/** The five characters that would otherwise be read as markup. */
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

/**
 * A template's plain-text body as the HTML a message is stored with.
 *
 * Escaped first, then wrapped: a template that contains `<script>` — because
 * somebody pasted an error message into it — becomes the *text* `<script>` in
 * the thread, not a tag. The sanitiser runs over the result afterwards as it
 * does over every other message body, so this is the first of two answers
 * rather than the only one.
 *
 * Blank lines separate paragraphs, which is what a person typing into a
 * textarea means by one, and single newlines inside a paragraph become `<br>`.
 */
export const paragraphsFrom = (text: string): string => {
  const escaped = text.replace(/[&<>"']/g, (character) => ESCAPES.get(character) ?? character);

  return escaped
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${block.replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
};
