# Macros and canned responses

A **canned response** is a reply agents send often, written once with
placeholders and in both languages. A **macro** is the same reply (optional)
plus actions: set the status, set the priority, add or remove a tag, assign.
Both are deliverable M3-06 (REQUIREMENTS §4.1), and both live on
**Admin → Automation → Macros**.

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

## Languages

Each item has an English and an Arabic body. The variant used is the one asked
for, else the contact's language, else the brand's default. An empty Arabic
variant falls back to English, and the picker says so.

## Applying one in the composer

**Macros and canned** in the composer toolbar, the **Macro** button in the
ticket header, or `/` typed into an empty reply opens the picker. It offers
what is shared with the ticket's department, shared with every department, or
the reader's own. ↑ and ↓ move, Enter applies, Esc closes.

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

A run takes `{ macroId, actions, reply? }`. Every staged action must be one of
the macro's own, or the run is refused with the ticketing refusal
`macro-changed` (409). Each action goes through the same checks a person's
own edit does; one refusal rolls back the reply too.

Changes to shared items are audited as `macro.created`, `macro.updated` and
`macro.deleted`, with the fields that moved. Personal items are not audited.

## For the rules engine

A workflow rule's *Send canned response* action ([automation.md](automation.md))
uses the same service. `CannedResponsesService.render(id, { locale, ticket,
agent?, tx? })` returns the rendered reply, reading through the request
transaction by default; the rules worker passes its own `tx`.
`listShared(tx)` is what the rule builder offers: shared canned responses
only, because a rule runs as nobody. `cannedResponsePort`
(`apps/api/src/macros/canned-response-port.ts`) adapts both to the engine's
ports and turns the plain-text body into escaped paragraphs.
