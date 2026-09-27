import {
  type CannedPlaceholder,
  renderTemplate,
  splitName,
  TEMPLATE_PLACEHOLDERS,
  type TemplatePlaceholder,
} from '@helpdock/schemas';

/**
 * Filling `{{contact.first_name}}` in a ticket template (M1-06) and a canned
 * response (M3-06). The renderer itself is `@helpdock/schemas`'
 * `placeholders.ts`, shared with the admin's previews; what lives here is the
 * list of values a subject fills, which only the api can read.
 */

export { renderTemplate, splitName };

/** What a caller knows about the ticket a template is being filled for. */
export interface TemplateSubject {
  readonly brand: { readonly name: string };
  /** Absent leaves every `contact.*` placeholder spelled out. */
  readonly contact?: { readonly name: string; readonly email: string | null } | undefined;
  /** Absent leaves `{{ticket.number}}` spelled out, which a preview has to. */
  readonly ticket?: { readonly number: string } | undefined;
  /** M3-06: whoever sends the reply. Absent leaves `{{agent.first_name}}` spelled out. */
  readonly agent?: { readonly name: string } | undefined;
}

/**
 * The names this subject can fill, as a `Map`. A `Map` rather than an object
 * literal because it has no prototype to inherit `constructor` or `toString`
 * from: `values.get('constructor')` is `undefined`, where `values.constructor`
 * would not be.
 */
export const templateValues = (subject: TemplateSubject): ReadonlyMap<string, string> => {
  const values = new Map<CannedPlaceholder, string>();

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

  if (subject.agent !== undefined) {
    values.set('agent.first_name', splitName(subject.agent.name).first);
  }

  return values;
};

/** Whether a name is one this renderer would ever fill, whatever the subject. */
export const isTemplatePlaceholder = (name: string): name is TemplatePlaceholder =>
  (TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name);

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
