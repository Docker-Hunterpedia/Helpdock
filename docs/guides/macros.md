# Macros and canned responses

A **canned response** is a reply agents send often, written once with
placeholders and in both languages. A **macro** is the same reply (optional)
plus actions: set the status, set the priority, add or remove a tag, assign,
snooze by one of the Snooze menu's times ([snooze.md](snooze.md)).
Both are deliverable M3-06 (REQUIREMENTS §4.1), and both live on
**Settings → Inbox → Macros**.

## Who may do what

| | Admin | Team Leader | Agent | Viewer |
|---|---|---|---|---|
| Use shared items on a ticket | yes | yes | yes | no |
| Create, edit or delete an item shared with every department | yes | only a Team Leader of every department | no | no |
| Create, edit or delete an item shared with one department | yes | in the departments they lead | no | no |
| Keep personal items | yes | yes | yes | no |

A personal item is its owner's alone, enforced by row-level security (the
`canned_responses_owner_only` policy): nobody else reads it, an Admin
included. Which departments a shared item is offered in is a service rule
(`apps/api/src/macros/macro-rules.ts`); a reply sent with one runs under the
sender's own ticket permissions, so an item never widens access.

## Placeholders

The allow-list is M1-06's template list plus the sender:

| Placeholder | Becomes |
|---|---|
| `{{contact.first_name}}`, `{{contact.last_name}}`, `{{contact.name}}`, `{{contact.email}}` | The ticket's contact |
| `{{ticket.number}}` | `HD-1042` |
| `{{brand.name}}` | The brand |
| `{{agent.first_name}}` | The first word of the sender's full name. For a rule, the sender is the ticket's assignee |
| `{{agent.name}}` | The name the sender chose for customers, their **public name** (their first name until they set one) |
| `{{agent.full_name}}` | The sender's full name, for the rare reply that should carry it |
| `{{agent.title}}` | The sender's job title in the language of the reply; English when there is no Arabic one; nothing when neither is set |
| `{{agent.phone}}` | The sender's phone, in international form; nothing when unset |
| `{{department.name}}` | The ticket's department, in the language of the reply |

The sender sets their public name, titles and phone on **Your account →
Profile** (see [Staff and roles](staff-and-roles.md#profile-for-customers)).
A value that is unset renders as nothing, so a customer never reads a
placeholder; the email address of the sender is not a placeholder.

**Signatures take them too.** A signature
(**Your account → Email signature**) may use `{{agent.name}}`, `{{agent.title}}`,
`{{agent.phone}}`, `{{department.name}}` and `{{brand.name}}`, so one brand-wide
instruction, "sign with `{{agent.name}}` and `{{agent.title}}`", works for every
agent. A signature line whose placeholder is empty (no phone number) is dropped.

An unknown placeholder is left as written, so a typo shows. Rendering is one
pass over a fixed list of names (`packages/schemas/src/placeholders.ts`), never
a path into an object.

**Fallbacks (M14-14).** `{{contact.first_name|there}}` renders "there" when the
value is empty or this ticket cannot give one (a ticket with no contact). The
words after `|` are literal text: they are never read as another placeholder,
and a fallback cannot hold `{`, `}` or `|` (a save with one is refused). Without a fallback an empty value
renders as nothing, as before.

**Checked when you save (M14-14).** The editor lists every placeholder that is
not on the list above and every `{{` with no closing `}}`, under the reply and
by language, with the nearest real name when it is a likely typo
("Unknown placeholder `{{agent.nmae}}`. Did you mean `{{agent.name}}`?"), and
will not save until they are fixed. The api refuses the same text with
`400` naming each one, on create and on any update that sends bodies. A
fallback is one run of text without `|`, `{` or `}` (the renderer reads no
more), so `{{contact.first_name|Sir|Madam}}` is refused too. An item saved
before this check that still holds a typo keeps working, and can be renamed or
re-scoped without touching its text (the editor and the api only re-check text
that changed); rendering leaves the typo as written.

## Shortcuts

Give a saved reply or a macro a **shortcut** (`refund`) in its editor. In a
reply, type `/refund` and press **Tab** or **Enter** to insert it without
opening the picker.

- A shortcut is one word: letters in any script, digits, `-` and `_`, up to 32
  characters, lower-cased when saved. The editor shows it after a `/`.
- It is **unique where it is offered**: two items shared with the same
  department (or one shared with every department and one with a department)
  cannot share one, a personal item cannot take a shortcut a shared item has,
  and two people may each keep the same personal shortcut. Saving a taken one
  is refused with the ticketing refusal `shortcut-taken` (409) and the field
  says so. Only items you can see count, so a refusal never reveals a
  colleague's personal item or a department you do not work in. The check runs
  under a transaction lock on the brand and the word, so two saves in different
  scopes take turns; a partial unique index per scope backs up saves in one
  scope. The check runs only when a save changes the shortcut, the scope or the
  department, so an item whose shortcut later collided can still be renamed or
  re-worded. If a person's personal shortcut and a shared one still meet (the shared
  item was created by someone who cannot see the personal one), `/word` offers
  the person's own first.
- Nothing is inserted until you choose. `/` opens a list under the text as soon
  as it is typed **at the start of the text, at the start of a line, or after a
  space or tab**; a `/` inside a word or a URL (`https://example.com/refund`,
  `and/or`) is text. The list narrows as the word grows: the exact shortcut
  first, then shortcuts that start with it, then names that contain it.
  ↑ and ↓ move, **Tab** or **Enter** insert, **Esc** puts the list away and
  keeps what you typed. With nothing matching, Enter is a new line.
- It is for **replies**. A note has no saved replies (use the toolbar button).
- Choosing one fills it in for the ticket, in the contact's language, in place
  of the `/word`, and stages a macro's actions as chips, exactly as the picker
  does. A macro with no reply runs at once and the `/word` goes.
- The list and the picker are ordered by use: **your own items first**, then
  the brand's; within each, the one used most recently, then the one used most
  often (`use_count`, counted when a reply sent with it leaves, beside
  `last_used_at`). The count is the item's own, so a shared item's order is the
  brand's, not each person's.

**`{{` in the composer** opens the placeholder list under the text. Choosing
one inserts the **value** for this ticket ("Mona", "HD-1042"), not the
`{{…}}`, because a reply is sent as typed. Only placeholders the composer can
fill are offered: the contact's, the ticket number, the brand and department,
and the sender's first and full name. `{{agent.name}}`, `{{agent.title}}` and
`{{agent.phone}}` are for saved replies and signatures, which the api fills in
from the sender's profile.

## Languages

Each item has an English and an Arabic body. The variant used is the one asked
for, else the contact's language, else the brand's default. An empty Arabic
variant falls back to English, and the picker says so.

## Applying one in the composer

**Macros** in the composer toolbar opens the picker, as does `m` and **Apply a
macro** in the command palette (the ticket header has no Macro button since
M14-19; `/` in a reply opens the shortcut list instead,
see [Shortcuts](#shortcuts)). It offers what is shared with the ticket's
department, shared with every department, or the reader's own, yours first and
then by use; its search finds an item by its shortcut too. ↑ and ↓ move, Enter
applies, Esc closes.

Applying fills the composer with the rendered reply (plain text you can edit)
and stages the macro's actions as chips above it; each can be removed. Sending
the reply runs the reply and the kept actions in **one request and one
transaction**, and the thread records **one** activity entry,
`ticket.macro_applied`, naming the macro. A macro's status wins over "Then set
status". A macro without a reply runs as soon as it is applied.

## API

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/brands/:brandId/macros?kind=&q=&departmentId=` | `ticket:read` |
| `POST` | `/api/brands/:brandId/macros` | `ticket:write` |
| `PATCH` | `/api/brands/:brandId/macros/:macroId` | `ticket:write` |
| `DELETE` | `/api/brands/:brandId/macros/:macroId` | `ticket:write` |
| `GET` | `/api/brands/:brandId/tickets/:ticketId/macros/:macroId/render?locale=` | `ticket:write` |
| `POST` | `/api/brands/:brandId/tickets/:ticketId/macro-runs` | `ticket:write` |

An item carries `shortcut` (a string or `null`) and `useCount`; create and
update take `shortcut`, and `PATCH` with `shortcut: null` clears it.

A run takes `{ macroId, actions, reply? }`. Every staged action must be one of
the macro's own, or the run is refused with the ticketing refusal
`macro-changed` (409). Each action goes through the same checks a person's
own edit does; one refusal rolls back the reply too.

Changes to shared items are audited as `macro.created`, `macro.updated` and
`macro.deleted`, with the fields that moved (the shortcut included). Personal items are not audited.

## For the rules engine

A workflow rule's *Send canned response* action ([automation.md](automation.md))
uses the same service. `CannedResponsesService.render(id, { locale, ticket,
agent?, tx? })` returns the rendered reply, reading through the request
transaction by default; the rules worker passes its own `tx`.
`listShared(tx)` is what the rule builder offers: shared canned responses
only, because a rule runs as nobody. `cannedResponsePort`
(`apps/api/src/macros/canned-response-port.ts`) adapts both to the engine's
ports and turns the plain-text body into escaped paragraphs.
