# Ticketing settings

How a brand's tickets are shaped and routed: departments, the teams inside
them, and the brand-level behaviour that later deliverables read. The screen is
**Admin → Ticketing**, and this guide follows its tab row.

Only the **Departments** tab is built. The other seven exist so the row is whole
and each says which deliverable fills it: Statuses and Priorities with M1-02,
Views with M1-05, Tags, Custom fields and Templates with M1-06, Assignment with
M1-07.

Who may do what comes from
[DOMAIN-RULES §1.2](../planning/DOMAIN-RULES.md#12-scope-rules). The short
version:

| | Admin | Team Leader | Agent, Viewer |
|---|---|---|---|
| Read the department list | yes | yes | yes |
| Add, delete or reorder departments | yes | no | no |
| Rename a department, set its default team | yes | in the departments they lead | no |
| Add, rename or delete a team | yes | in the departments they lead | no |
| Put somebody on a team, or take them off | anybody | Agents and Viewers only | no |
| Change the brand's name, language, time zone or settings | yes | no | no |

"Which departments a brand has" is the brand's shape, so it stays with the
Admin. "What is inside one" is the Team Leader's, which is what §1.2 means by
"departments they lead".

---

## Departments

A department decides where a ticket is filed and who can see it. An Agent sees
tickets in their departments and nowhere else, so a brand's departments are the
first thing to get right.

Every brand starts with one, called **General**, created by the first-run
wizard (and by `pnpm --filter @helpdock/api seed:dev` on a development
install).

### The list

Each row shows the department's name, its Arabic name underneath when it has
one, how many teams it holds, how many distinct people are on those teams, and
its default team. The row menu offers **Edit**, **Move up**, **Move down** and
**Delete**.

The order is the brand's own and is what every picker draws. Reordering has
three ways in and one path out: drag the handle, focus it and press `↑`/`↓`, or
use **Move up** / **Move down** in the row menu. All three send the whole list,
so a stale client cannot half-reorder the brand.

### The editor

Selecting a row fills the card in the side column:

| Field | Notes |
|---|---|
| Name | Required, up to 120 characters, unique inside the brand whatever its case. |
| Name (Arabic) | Optional. M1-01 prints it under the Latin name on the department list, in both locales. Customers see it once the help center and the widget render a department. |
| Default team | One of *this* department's teams, or none. Where a ticket lands when no rule picks a team (M1-07 acts on it). Deleting that team leaves the department with no default rather than a dangling one. |

### Deleting one

Two things refuse a delete:

- **It is the brand's last department.** A brand with none has nowhere to file a
  ticket, and nothing in the product would create one back.
- **Tickets still belong to it.** Move them first. The count runs in the
  request's own transaction, so the department-scoped policies of DOMAIN-RULES
  §1.3 apply to it — which is safe because deleting a department is
  `brand:manage`, and an Admin's department scope is always "all"
  (`apps/api/src/brands/department-deletion.ts`). Soft-deleted tickets count
  too: they are hidden from views until retention purges them, and a department
  deleted underneath one would leave a row that cannot be restored anywhere.

Deleting a department takes its teams and their memberships with it. It does not
touch anybody's role in the brand.

## Teams

A team is a group inside one department that work can be routed to. Selecting a
department opens its teams under the list.

- A team's name is unique inside its department. The same name in another
  department is fine.
- Members come from a picker that only offers people whose own department scope
  reaches this department — an Agent assigned to Billing is not offered for a
  Technical team, because they could not see the tickets it would be given.
  Deactivated accounts are not offered either.
- **A Team Leader's picker is narrower still.** DOMAIN-RULES §1.2 holds team
  membership to the same ceiling as a role change: a Team Leader adds and
  removes Agents and Viewers, and nobody else. An Admin, another Team Leader —
  and the Team Leader themselves — go on a team only when an Admin puts them
  there. That is what stops M1-07 from letting a Team Leader route work to an
  Admin. The picker is filtered by who is asking, so it never offers a person
  the save would refuse.
- Removing somebody from a team does not change their role in the brand.
- Losing the role does remove them from the lists: the query joins
  `user_brand_roles`, so somebody whose membership was revoked stops appearing
  without the row having to be deleted. Giving the role back brings them back.

Teams are stored and served now; **assignment to them is M1-07** (round-robin
per department, skills, load cap), and **business hours per department are M3**.

## Brand settings

Each brand carries a small JSON object of ticketing behaviour. M1-01 stores and
serves it; the deliverables below act on it.

| Key | Default | Meaning | Acted on by |
|---|---|---|---|
| `autoAwaitOnAgentReply` | `true` | Move a ticket to "Awaiting customer" when an agent sends a public reply (DOMAIN-RULES §2.1). | M1-08 |
| `reopenPolicy` | `{ "kind": "within_days", "days": 7 }` | What a customer reply to a closed ticket does: `within_days` (1–365), `always`, or `never` (DOMAIN-RULES §2.3). | M1-08 |

Every key has a default, so a brand created before a key existed reads as the
current shape rather than failing. A column somebody edited by hand into
something the schema refuses falls back to the defaults rather than answering
500 — these settings describe behaviour, and behaviour has to have an answer.

`PATCH /api/brands/:brandId` is what writes them, together with the brand's
name, default locale and time zone. **The prefix is not editable**: it is
printed in every ticket number the brand has ever issued, so REQUIREMENTS §3
fixes it at creation.

> The screen for the brand's own fields belongs on **Admin → Settings**, as a
> "Brand" tab, rather than in the Ticketing tab row. That page is still the
> milestone placeholder and has no artboard yet, so M1-01 ships the endpoint and
> leaves the tab to the deliverable that designs that screen.

DOMAIN-RULES §2.3 lets a Team Leader set the reopen policy. `PATCH
/api/brands/:brandId` is `brand:manage`, which only an Admin holds, because the
same body carries the time zone; **M1-08** adds the narrower route a Team Leader
reaches, where the policy is acted on.

## Adding a brand

An install admin adds a brand with `POST /api/install/brands`. It is the
first-run wizard's brand step minus the parts that only make sense once, and it
does four things in one transaction:

1. creates the brand, whose insert trigger creates its ticket sequence;
2. gives whoever asked an `admin` role in it, so it is reachable;
3. creates one department, `General` unless the request names another;
4. writes a `brand.created` audit row under the install scope, and a second
   inside the new brand, so its own log is not empty at birth.

The prefix is unique across the install and is refused as a rejected field
(`400`, `fields: [{ path: "prefix" }]`) when it is taken.

The new role reaches the caller's access token on their next sign-in or refresh,
which DOMAIN-RULES §1.6 caps at ten minutes. Until then the api answers 403 for
the new brand — the same lag every role change has.

## Endpoints

Every brand-scoped route below runs inside that brand's own transaction and
writes an audit row for every change. `POST /api/install/brands` is the
exception: it has no brand in its path, runs in install scope, and is audited
there as well as in the brand it creates.

| Route | Declaration | Answers |
|---|---|---|
| `GET /api/brands/:brandId/departments` | `@Requires('brand:read')` | The list with team and people counts. |
| `POST /api/brands/:brandId/departments` | `@Requires('brand:manage')` | Creates one at the end of the list. |
| `POST /api/brands/:brandId/departments/reorder` | `@Requires('brand:manage')` | The whole order; a partial list is a 400. |
| `PATCH /api/brands/:brandId/departments/:departmentId` | `@Requires('staff:manage')` | Name, Arabic name, default team. Team Leaders inside their scope. |
| `DELETE /api/brands/:brandId/departments/:departmentId` | `@Requires('brand:manage')` | 409 for the last one, or while tickets reference it. |
| `GET /api/brands/:brandId/departments/:departmentId/teams` | `@Requires('brand:read')` | The department's teams with their members. |
| `POST/PATCH/DELETE …/departments/:departmentId/teams[/:teamId]` | `@Requires('staff:manage')` | Create, rename, delete. Team Leaders inside their scope. |
| `GET …/departments/:departmentId/eligible-members` | `@Requires('staff:manage')` | Who the people picker may offer. |
| `POST …/teams/:teamId/members` | `@Requires('staff:manage')` | Adds somebody eligible. 409 otherwise. |
| `DELETE …/teams/:teamId/members/:userId` | `@Requires('staff:manage')` | Takes them off the team, not out of the brand. |
| `PATCH /api/brands/:brandId` | `@Requires('brand:manage')` | Name, default locale, time zone, settings. Never the prefix. |
| `POST /api/install/brands` | `@Requires('install:admin')` | An additional brand. Audited. |

### Refusals

A refused action answers with a code rather than a sentence, so the screen picks
the translated copy:

| `error.ticketing.reason` | Status | Means |
|---|---|---|
| `out-of-scope` | 403 | The department is outside the ones the actor leads; or they are not an Admin and the action changes the brand's list; or a Team Leader tried to put somebody above their ceiling on a team, or take them off one. |
| `last-department` | 409 | A brand keeps at least one department. |
| `department-in-use` | 409 | Tickets still belong to it (from M1-02). |
| `name-taken` | 409 | Another department of the brand, or another team of the department, has that name. |
| `not-eligible` | 409 | That person holds no role in this brand that reaches this department. |

A department of another brand is invisible to the request's transaction, so it
answers **404**, not 403: "there is no such id" and "it is not yours" are the
same answer.

## Data model

Three tenant tables, all under a `FORCE`d row-level security policy on
`brand_id` (DOMAIN-RULES §1.3):

| Table | Columns that matter | Notes |
|---|---|---|
| `departments` | `name`, `name_ar`, `default_team_id`, `sort_order` | Unique on `(brand_id, name)`. `default_team_id` is `ON DELETE SET NULL`. |
| `teams` | `department_id`, `name`, `sort_order` | Unique on `(department_id, name)`. Cascades from its department. |
| `team_members` | `team_id`, `user_id` | Unique on `(team_id, user_id)`. Cascades from its team and from the account. |

Neither `teams` nor `team_members` is department-scoped in the row-level
security sense: §1.3 lists the six ticket-scoped tables and neither is one. A
Team Leader's scope is a service-layer rule
(`apps/api/src/brands/department-scope.ts`), exactly as it already is for
`departments` itself.

`brands.settings` is a `jsonb` column rather than rows in `settings`: these are
the brand's own fields, read with the brand in one row, and `settings` is
install-wide configuration an operator may pin with an environment variable —
which none of these may ever be.

## See also

- [Staff and roles](staff-and-roles.md) — who holds which role, and how
  department scope is set per person.
- [DOMAIN-RULES §1.2](../planning/DOMAIN-RULES.md#12-scope-rules) — the
  authorization matrix this guide transcribes.
- [DOMAIN-RULES §2.3](../planning/DOMAIN-RULES.md#23-reopen-policy) — the reopen
  policy in full.
