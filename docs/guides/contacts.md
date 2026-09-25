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
        ├── contact_duplicate_suggestions   "these two might be the same"
        └── contact_merges       a merge and exactly what it moved (M1-13)
```

All six tables are **brand-scoped and never department-scoped**. An Agent may
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

A caller never says whether an identifier is verified; it says **where it came
from**, and `isVerifiedIdentity(kind, source)` answers from the table above
(`IDENTITY_SOURCE_RULES` in `packages/schemas/src/identity-rules.ts`, M1-13):

| Source | Kinds | Verified |
|---|---|---|
| `email.inbound`, `email.magic_link` | email | yes |
| `telegram.bot` | telegram | yes |
| `widget.signed` | external | yes |
| `widget.visitor` | visitor | yes |
| `widget.form` | email, phone | no |
| `email.cc` | email | no |
| `agent`, `import` | any | no |

Nothing an agent types is verified, and no source verifies a phone number. A
kind the source cannot produce — a phone number "from the Bot API" — throws a
`TypeError`, as a programming error rather than a request the api declines.

### The seam every channel uses

`findOrCreateContactByIdentity(tx, brandId, { kind, value, source }, options)`
in `apps/api/src/contacts/identity.ts` is the one function that turns "a message
arrived from X" into a contact row. M2 (email), M4 (widget) and M6 (Telegram)
all call it, inside their own transaction, so the contact and the domain change
commit together.

**Auto-merge happens only when both sides of the match are verified**
(DOMAIN-RULES §4.4):

| The claim is | Another contact holds it | What happens |
|---|---|---|
| verified | verified | that contact is returned |
| verified | unverified | **a new contact takes the identifier**, verified, plus a duplicate suggestion |
| unverified | either | **a new contact**, plus a duplicate suggestion |
| either | nobody | a new contact holding the identifier |

The middle rows are the point. Matching on a typed address would let anybody
who knows it walk into that person's history through a pre-chat form, and would
equally let a typed address pull a real inbound email into the typist's
contact. So a hint on either side becomes a suggestion, and an agent decides.
When the claim is proof and the holder's is a hint, the identifier moves to the
contact that can prove it, because the unique index allows one holder.

## Duplicates

A suggestion names two contacts and **why** they were suggested:

| Reason | Raised when | The pill says |
|---|---|---|
| `email` | an unverified email matched another contact's | email typed in a form |
| `phone` | a phone number matched (never verified in v1) | same phone |
| `telegram`, `visitor`, `external` | that identifier matched with one side unverified | same … |
| `similar_name` | a contact landed under an account where another contact's name reads alike (pg_trgm `similarity` ≥ 0.4) | similar name |

It is raised **once per pair, in either direction**: a third form submission
from the same address is not a third opinion, and a dismissed pair is never
raised again, whichever of the two is discovered first next time.

The contact screen shows the suggestion under the identifiers — in a card of its
own when there is more than one — with two actions:

- **Not the same** dismisses it (`POST …/duplicates/:suggestionId/dismiss`).
- **Merge…** opens the merge dialog below.

The contact list counts the open suggestions and links to the filtered list
(`/contacts?duplicates=true`). A suggestion whose other contact has been merged
away is hidden until that merge is undone.

## Identity rules and merging (M1-13)

The agent chooses **which contact survives** — its name and details are kept —
and the other is folded into it:

- **Identifiers** move to the survivor **as they are**. Verification never
  upgrades by merging: a typed address stays "unverified" beside a proven one,
  because a merge is an agent's judgement, not proof.
- **Notes** move too.
- **Every ticket** moves, including tickets in departments the agent cannot see
  — a contact is brand-scoped, and leaving the hidden half of somebody's history
  on a contact nobody can find would split the person in two. The dialog's
  ticket counts include those hidden tickets (DOMAIN-RULES §1.2 lets a count be
  shown). **Tickets are not merged with each other**; that is M1-09's.
- The merged contact **stays as a row** with `merged_into_id` set. Lists and
  lookups skip it, every write to it answers `merged` (409), and opening it in
  the admin goes on to the survivor.
- One `contact_merges` row records exactly which identifiers, notes and tickets
  moved, and an audit entry `contact.merged` records the counts — never an
  identifier's value.

**Undo** is offered in the toast after the merge and in a banner on the survivor
for 24 hours. It moves back exactly what the merge moved — a ticket the survivor
gained since stays — reopens the suggestion the pair came from, and writes
`contact.merge.undone`. It is refused with `merge-expired` after 24 hours or a
second time, and with `merge-blocked` once the survivor has itself been merged
into somebody else or either contact has been erased.

An **erased** contact cannot be merged (`anonymised`), and a merged contact
cannot be erased (`merged`); undo the merge first.

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
- The **files they sent** are deleted: every attachment they uploaded and every
  attachment on a message they wrote. The rows go in the erasure's transaction;
  the objects are queued through the outbox and deleted by the worker (M1-14).
- The **channel ids** of the messages they wrote (`external_message_id`) are
  cleared. The messages themselves stay, still attributed to the erased contact,
  and the bodies are kept under the brand's
  [retention](data-retention.md).
- The audit row also carries `attachmentCount` and `messageCount`.
- An erased contact is immutable afterwards: every write answers
  `anonymised` (409). `contacts.anonymised_at` is the marker: anything that
  matches contacts — duplicate suggestions, the merge of M1-13 — skips a row
  where it is set.

The screen asks for the person's name to be typed before the Anonymise button
wakes up, and only an Admin is offered the button at all.

There is no undo.

## Permissions

| Action | Needs |
|---|---|
| Read contacts, accounts, timeline | `contact:read` — every role, Viewer included |
| Create, edit, add or remove an identifier, note, dismiss a duplicate, merge, undo a merge | `contact:write` — Admin, Team Leader, Agent |
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
| `GET /contacts/:contactId/merge-preview?otherContactId=` | `contact:read` | Both sides with their ticket counts (hidden ones included) and the identifiers after a merge. |
| `POST /contacts/:contactId/merge` | `contact:write` | `{ mergedContactId, suggestionId? }`: folds that contact into this one. Answers this contact. |
| `POST /contacts/:contactId/merges/:mergeId/undo` | `contact:write` | Takes the merge back within 24 hours. |
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
says how), `last-identity`, `anonymise-forbidden`, `anonymised`,
`domain-taken`, `merged`, `merge-self`, `merge-expired` or `merge-blocked`. The admin turns the code into a sentence; no English crosses the
boundary. None of the messages repeats the identifier that was refused, because
"that address is taken" told to a stranger who is guessing addresses is an
enumeration oracle.

## Where the ticket numbers come from

Nothing in `apps/api/src/contacts/` knows the ticket schema. Both ticket-shaped
answers arrive through interfaces declared in
`apps/api/src/contacts/providers.ts`:

- `TicketStatsProvider` — open and total counts, CSAT, average first reply, last
  ticket date, per contact. It takes a whole page of contacts at once, because
  fifty rows must not be fifty queries.
- `ContactTimelineProvider` — the tickets this viewer may see, plus
  `hiddenCount`, the DOMAIN-RULES §1.2 count of the ones they may not.

M1-04 shipped first and its implementations answered "none yet". M1-02
implements both in `apps/api/src/tickets/contact-providers.ts` and passes them
to `ContactsModule.forRoot`; nothing in `contacts/` changed.

Two things are worth knowing about the real ones:

- **Both read through the request's own transaction**, so the timeline and the
  counts are department-scoped like everything else: "an agent viewing a contact
  timeline sees only the tickets they are allowed to see" (§1.2).
- **`hiddenCount` cannot come from a scoped read** — a row the policy hides is a
  row no scoped query can count. It comes from `helpdock_contact_ticket_count`,
  which turns `app.all_departments` on for the duration of one call and leaves
  `app.brand_ids` alone. So it looks past the *department* predicate and not
  past the brand one: another brand's rows stay invisible to it exactly as they
  are to every other read, and it counts them as zero rather than raising. It
  runs with the caller's own rights — row-level security here is `FORCE`d, which
  binds the table owner too, so `SECURITY DEFINER` would buy nothing and cost an
  audit — and it returns a *number*, so there is no row for it to leak. The
  agent learns that history exists and nothing about what is in it.

`csat` and `averageFirstReplySeconds` are still null: CSAT is M1-12 and the
first-response clock is M3-02, and a zero would read as "rated badly" and
"answered instantly" rather than "not measured yet".

`withOpenTickets` answered `null` while it could not answer, and the "Has open
tickets" filter then narrowed nothing — a chip that hid every row would look
like a broken list rather than an honest zero. It answers a real list now.

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

- **Merging starts from a suggestion.** The api merges any two contacts of the
  brand, but the admin offers it only from a duplicate suggestion: the "merge
  with…" picker in the contact menu has no artboard yet.
- **A merge does not carry the merged contact's other suggestions over.** They
  are hidden while the merge stands and come back if it is undone.
- **Search is `ILIKE`, not trigram.** `contacts.name` and
  `contact_identities.value` are scanned with `ILIKE`; the trigram GIN index of
  [ARCHITECTURE §5](../planning/ARCHITECTURE.md#5-data-model-core-tables) would
  not be used under `FORCE ROW LEVEL SECURITY`, for the reason the ticket guide
  gives. When contact search needs an index it follows
  [ADR 0011](../decisions/0011-ticket-search-token-table.md).
- **Tags are a placeholder.** The `tag` query parameter is accepted and ignored.
  Tagging a *contact* is nobody's deliverable yet: M1-06's tags hang off
  tickets, and REQUIREMENTS §4.1 gives a contact custom fields instead.
- **Custom field values are validated, not yet edited here.** `PATCH` on a
  contact or an account takes a `custom` object and checks it against the
  brand's own definitions ([ticketing settings](ticketing-settings.md#custom-fields));
  the details card reads the values, and the screen that edits them field by
  field is M1-15's.
- **Erasure reaches what exists today.** DOMAIN-RULES §11 also says it deletes
  the attachments the person sent and rewrites message author fields. Neither
  table exists yet — messages are M1-03 and attachments are M1-10 — so the
  erasure covers the contact, its identifiers and its notes, and each of those
  milestones has to extend it.
- **`contacts.notes_count` is denormalised.** It is written in the same
  transaction as the note, so nothing else may insert into `contact_notes`
  without going through the repository.
