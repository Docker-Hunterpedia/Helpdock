# Contacts and accounts

How Helpdock decides that two messages came from the same person, what it does
when it is not sure, and what happens when somebody asks to be forgotten.

Shipped by **M1-04**. The rules come from
[DOMAIN-RULES §4](../planning/DOMAIN-RULES.md#4-identity-and-conversation-ownership)
and [§11](../planning/DOMAIN-RULES.md#11-data-lifecycle); the scope rules come
from [§1.2](../planning/DOMAIN-RULES.md#12-scope-rules). Where this guide and
those disagree, those win.

## The model

```
accounts      one customer company per brand; a name, an optional email domain
  └── contacts        one person per brand
        ├── contact_identities   how that person is recognised
        ├── contact_notes        what agents wrote about them
        └── contact_duplicate_suggestions   "these two might be the same"
```

All five tables are **brand-scoped and never department-scoped**. An Agent may
open any contact in the brand; what they may not see is the *tickets*, and the
timeline says how many are hidden rather than pretending they do not exist
(DOMAIN-RULES §1.2).

A contact carries a name, an optional account, an optional language and
timezone, an optional customer id (`external_id`, the brand's own reference),
a `custom` JSON object for the fields M1-06 will define, and a note count.
`locale` and `timezone` are nullable because "we have not been told" is a
different fact from "English, UTC": a null falls back to the brand's defaults.

## Identities

An identity is one way of recognising a person: an `email`, a `phone`, a
Telegram `chat_id`, a widget `visitor` id, or the brand's own `external` user
id.

**The value is always normalised before it is stored.** That is the whole
mechanism: `contact_identities` is unique on `(brand_id, kind, value)`, so two
spellings of one address have to collide or one person becomes two contacts.
`packages/schemas/src/contact.ts` is the single place that decides what
normalised means, because the admin, the api and the widget all have to agree.

| Kind | Normalised to |
|---|---|
| `email` | trimmed, lower-cased, validated |
| `phone` | E.164, international format only ([ADR 0008](../decisions/0008-phone-normalisation.md)) |
| `telegram` | the chat id as digits (negative for a group) |
| `visitor` | the issued UUID, lower-cased |
| `external` | trimmed, never case-folded — the brand chose the spelling |

Arabic-Indic (`٠١٢…`) and Eastern Arabic-Indic (`۰۱۲…`) digits become Latin
first, so a number typed on an Arabic keyboard is the same number.

The same identifier may belong to **different people in different brands**: the
unique index is per brand, because two brands of one deploy must not learn about
each other's customers.

### Verified or not

> An identifier someone types is a hint, not proof. — DOMAIN-RULES §4

| Identifier | Verified when | Auto-merge |
|---|---|---|
| Email | An inbound email arrived from it, or a magic link sent to it was clicked | Yes |
| Telegram chat id | Always (it comes from the Bot API) | Yes |
| Signed `external_id` | Always (HMAC) | Yes |
| Visitor id | Always (the server issued it) | Yes |
| Phone | **Never in v1** — Helpdock sends no SMS | No |
| Email typed into a form | Never | No; suggests a duplicate |

Nothing an agent types is verified. The api refuses `verified: true` on a phone
number outright, as a programming error rather than a request it declines,
because no caller has the standing to claim it.

### The seam every channel uses

`findOrCreateContactByIdentity(tx, brandId, claim, options)` in
`apps/api/src/contacts/identity.ts` is the one function that turns "a message
arrived from X" into a contact row. M2 (email), M4 (widget) and M6 (Telegram)
all call it, inside their own transaction, so the contact and the domain change
commit together.

| The identifier is | What happens |
|---|---|
| verified, and another contact holds it | that contact is returned |
| verified, and nobody holds it | a new contact, with the identifier verified |
| unverified, and another contact holds it | **a new contact**, plus a duplicate suggestion |
| unverified, and nobody holds it | a new contact, with the identifier unverified |

The third row is the point. Matching on a typed address would let anybody who
knows it walk into that person's history through a pre-chat form. So the hint
becomes a suggestion, and an agent decides.

An identifier that was unverified and is later proven — an address somebody
typed, that an email then arrived from — is promoted in place rather than
duplicated.

## Duplicates

A suggestion names two contacts and which identifier kind they share. It is
raised **once per pair**: a third form submission from the same address is not a
third opinion, and a dismissed pair is never raised again.

The contact screen shows it as a warning row with two actions:

- **Not the same** dismisses it (`POST …/duplicates/:suggestionId/dismiss`).
- **Merge** is drawn but disabled, with the reason on the button. Merging, and
  its 24-hour undo, is **M1-13**.

The contact list counts the open suggestions and links to the filtered list
(`/contacts?duplicates=true`).

## Erasure

"Anonymise contact" implements DOMAIN-RULES §11's privacy request.

- **Admin only**, in the brand the contact belongs to. `contact:write` buys an
  edit; this is not an edit, and the service refuses any other role with
  `anonymise-forbidden`.
- The **row survives**. Tickets, messages and audit rows point at it, and a
  deleted row would turn a history into ids nobody can explain.
- The name becomes `Erased contact`; the account, customer id, language,
  timezone and custom fields are cleared; the notes are deleted.
- Every identifier's value is replaced by `erased:<kind>:<digest>`, where the
  digest is derived from the **contact id**, not from the value. Nobody holding
  the digest can confirm a guessed address by hashing one of their own.
- Any open duplicate suggestion naming them is dismissed. An erased contact is
  not a merge candidate, and a suggestion left open would keep offering somebody
  else's screen a link to a person who has been erased.
- The audit row records counts and kinds — how many identifiers, which kinds,
  how many notes — and **no value of any kind**.
- An erased contact is immutable afterwards: every write answers
  `anonymised` (409).

There is no undo.

## Permissions

| Action | Needs |
|---|---|
| Read contacts, accounts, timeline | `contact:read` — every role, Viewer included |
| Create, edit, add or remove an identifier, note, dismiss a duplicate | `contact:write` — Admin, Team Leader, Agent |
| Erase a contact | `contact:write` **and** the Admin role in that brand |

## API

All routes are under `/api/brands/:brandId`, and all of them run in that brand's
tenant transaction.

| Route | Declaration | Answers |
|---|---|---|
| `GET /contacts` | `contact:read` | The list. `search`, `accountId`, `hasOpenTickets`, `tag`, `duplicates`, `cursor`, `limit`. |
| `POST /contacts` | `contact:write` | Creates one, with any identifiers given. 409 if one is taken. |
| `GET /contacts/:contactId` | `contact:read` | The contact, its identifiers, account, notes, duplicate suggestions and stats. |
| `PATCH /contacts/:contactId` | `contact:write` | Name, account, language, timezone, customer id. |
| `GET /contacts/:contactId/timeline` | `contact:read` | `{ items, notes, hiddenCount }`. |
| `POST /contacts/:contactId/identities` | `contact:write` | Adds one, normalised. |
| `DELETE /contacts/:contactId/identities/:identityId` | `contact:write` | Removes one, never the last. |
| `POST /contacts/:contactId/notes` | `contact:write` | Adds a staff-only note. |
| `POST /contacts/:contactId/duplicates/:suggestionId/dismiss` | `contact:write` | "Not the same". |
| `POST /contacts/:contactId/anonymise` | `contact:write` + Admin | The erasure above. |
| `GET /accounts` | `contact:read` | The companies, with contact counts. |
| `POST /accounts` | `contact:write` | Creates one. 409 if the domain is taken. |
| `GET /accounts/:accountId` | `contact:read` | The account and the people filed under it. |
| `PATCH /accounts/:accountId` | `contact:write` | Name and domain. |

**Pagination is a keyset, not an offset.** `nextCursor` is the last id of the
page; ids are UUIDv7 and therefore time-ordered, so a contact created while
somebody is paging does not shift the rows under them.

A refused action answers with the usual error body plus a `contact` block:

```json
{
  "error": {
    "code": "conflict",
    "message": "That identifier already belongs to a contact in this brand",
    "requestId": "…",
    "contact": { "reason": "identity-taken" }
  }
}
```

`reason` is one of `identity-taken`, `identity-invalid` (with a `problem` that
says how), `last-identity`, `anonymise-forbidden`, `anonymised` or
`domain-taken`. The admin turns the code into a sentence; no English crosses the
boundary. None of the messages repeats the identifier that was refused, because
"that address is taken" told to a stranger who is guessing addresses is an
enumeration oracle.

## Tickets are not here yet

M1-04 ships before M1-02, so there are no tickets to count. Rather than leave a
hole in the screens, the api serves both ticket-shaped answers through
interfaces in `apps/api/src/contacts/providers.ts`:

- `TicketStatsProvider` — open and total counts, CSAT, average first reply, last
  ticket date, per contact.
- `ContactTimelineProvider` — the tickets this viewer may see, plus
  `hiddenCount`, the DOMAIN-RULES §1.2 count of the ones they may not.

The v1 implementations answer "none yet". M1-02 passes real ones to
`ContactsModule.forRoot` and nothing else in that folder changes.

One deliberate nuance: `withOpenTickets` answers `null` rather than an empty
list while it cannot answer, and the "Has open tickets" filter then narrows
nothing — a chip that hid every row would look like a broken list rather than an
honest zero.

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `contacts.defaultCallingCode` | empty | Country calling code prefixed to phone numbers typed without one, for example `49`. Empty refuses them instead (ADR 0008). |

It is declared `scope: 'brand'`, so it becomes a per-brand value once per-brand
setting resolution lands (the open gap in
[`packages/db/README.md`](../../packages/db/README.md#known-gaps)); until then
`Settings.get` answers install-wide. It can be pinned from the environment as
`HD_CONTACTS_DEFAULT_CALLING_CODE`.

## Known gaps

- **Merge is M1-13.** The suggestion table and the dismissal ship here; the
  merge itself, its 24-hour undo and the participants (contact + CCs) on a
  ticket do not.
- **Search is `ILIKE`, not trigram.** `contacts.name` and
  `contact_identities.value` are scanned with `ILIKE`; the trigram GIN index of
  [ARCHITECTURE §5](../planning/ARCHITECTURE.md#5-data-model-core-tables) arrives
  with the ticket index set in M1-15.
- **`tickets.contact_id` has no foreign key yet.** The `tickets` table is M1-02's
  and did not exist when this migration was written. The constraint belongs to
  whichever of the two lands second.
- **Tags are a placeholder.** The `tag` query parameter is accepted and ignored
  until M1-06 defines tags.
- **Custom fields are stored, not edited.** `contacts.custom` and
  `accounts.custom` are read by the details card; the editor is M1-06.
- **Erasure reaches what exists today.** DOMAIN-RULES §11 also says it deletes
  the attachments the person sent and rewrites message author fields. Neither
  table exists yet — messages are M1-03 and attachments are M1-10 — so the
  erasure covers the contact, its identifiers and its notes, and each of those
  milestones has to extend it.
- **`contacts.notes_count` is denormalised.** It is written in the same
  transaction as the note, so nothing else may insert into `contact_notes`
  without going through the repository.
