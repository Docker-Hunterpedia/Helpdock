# Owner decisions for Helpdock 1.x

Status: decided (2026-10-20)
Opened: 2026-10-20
Owner: @Docker-Hunterpedia

Every open question from the Phase 5 plans ([PRD §4, Phase 5](PRD.md#phase-5--1x)), in one place, so the owner can answer them in one pass. Each row carries the plan's recommendation. An answer goes in the last column, with its date; the plan doc and, where the answer changes scope, the PRD are then updated in the same pull request. A question left open does not block a milestone from starting; the recommendation stands until it is answered.

Ids are stable: plan docs refer to them as `D-nn`.

## General

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-01 | **Release mapping.** Ship 1.x as: **1.0.1** the security and UX patch (in flight); **1.1** M12 AI workspace, M14 Inbox productivity, M18 Sign-in options, and M13's MCP-server deliverables M13-09 to M13-11; **1.2** the rest of M13, M15 Self-host operations, M16 More importers and undo, M19 Customer surfaces polish; **1.3** M17 Apps and languages; **later 1.x, on demand** M20 Native clients and SDKs. Answers the version questions of M12 (Q8), M13 (Q9) and M18 (Q7). | Accept as proposed. M18 goes in 1.1 because its OAuth binding change alters sign-in for existing users and wants a minor version with a release note. | All plans | Accepted as recommended. (2026-10-20) |
| D-02 | **Split the apps and languages work in two.** M17 Apps and languages keeps the locale registry, translation workflow, customer-facing and admin locales, the installable admin (PWA) and mobile agent layouts (about 59 days); M20 Native clients and SDKs takes the headless widget client, the React Native and Flutter SDKs and the Electron desktop shell (about 45–57 days). | Split. M20 is a separate milestone rather than "M17b" so deliverable ids, issues and GitHub milestones keep the `M<n>-<nn>` form, and because the halves have different dependencies and timing. | [M17](../in-development/M17-apps-and-languages.md), [M20](../in-development/M20-native-clients-and-sdks.md) | Accepted as recommended. (2026-10-20) |
| D-03 | **The command palette and the assistant panel.** M14-05's palette offers a person's own actions only and has no AI of its own. M12-13 adds one hook: Tab in the palette hands the typed text to the read-only assistant panel as a new question. Built by whichever of the two lands second. | Accept. The panel changes nothing in M12, so the hook gives the palette no new power; any change the assistant proposes waits for M13's approval cards. | [M12-13](../in-development/M12-ai-workspace.md), [M14-05](../in-development/M14-inbox-productivity.md) | Accepted as recommended. (2026-10-20) |

## M12 AI workspace

Plan: [M12-ai-workspace.md](../in-development/M12-ai-workspace.md).

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-04 | How long are staff assistant panel conversations kept? | The brand's AI-log window (default 90 days), deletable by their author at any time. | M12 Q1 | Accepted as recommended. (2026-10-20) |
| D-05 | In which language are ticket summaries written? | The brand's default staff language, with Translate on the card. A summary per viewer language would double the cost. | M12 Q2 | Accepted as recommended. (2026-10-20) |
| D-06 | What is a Q&A snippet's default visibility? | Public, because Improve answer fixes visitor answers; the dialog shows the choice. | M12 Q3 | Accepted as recommended. (2026-10-20) |
| D-07 | Do playground and test runs count toward the brand's AI budget? | Yes, it is real spend, and they stop at the hard stop. The alternative is a small exempt allowance. | M12 Q4 | Accepted as recommended. (2026-10-20) |
| D-08 | Add an install setting for per-model prices, so local or unlisted models show cost estimates? | Yes, install admin only. | M12 Q5 | Accepted as recommended. (2026-10-20) |
| D-09 | Default maximum assistant replies per conversation before a handoff? | 20. | M12 Q6 | Accepted as recommended. (2026-10-20) |
| D-10 | How does a persona appear on email? | The AI reply's sign-off is the persona name; the `From` name stays the department's, to keep threading and DMARC simple. | M12 Q7 | Accepted as recommended. (2026-10-20) |

## M13 AI actions and integrations

Plan: [M13-ai-actions-and-integrations.md](../in-development/M13-ai-actions-and-integrations.md).

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-11 | Ship Helpdock as an MCP server (M13-09 to M13-11) earlier? It gives Helpdock's own model no tools, so it fits the 1.0 rule: an outside client acts as the user through the API. | Yes: start beside M12 and release in 1.1 if ready (see D-01). | M13 Q1 | Yes: MCP server in 1.1. (2026-10-20) |
| D-12 | One brand per OAuth grant to the MCP server? | Yes; connect twice for two brands. The alternative is multi-brand grants with a brand argument on every tool. | M13 Q2 | Accepted as recommended. (2026-10-20) |
| D-13 | Maximum tickets in one approved bulk change: 50 or 25? | 50. | M13 Q3 | Accepted as recommended. (2026-10-20) |
| D-14 | May the staff assistant propose public replies? | Yes, as a proposal that shows the full text and "Sends to the customer", sent as the approver. | M13 Q4 | Accepted as recommended. (2026-10-20) |
| D-15 | Default for customer-facing change tools when the visitor's identity is not signed. | Off (`verifiedOnly` on); an Admin may turn it off per tool, with a warning. | M13 Q5 | Off by default (`verifiedOnly`), per-tool override with a warning. (2026-10-20) |
| D-16 | Support the legacy HTTP+SSE MCP transport for older servers? | No: Streamable HTTP only; revisit on demand. | M13 Q6 | Accepted as recommended. (2026-10-20) |
| D-17 | Integrations catalog: Linear, GitHub, Jira/Confluence, Sentry, Slack, Notion, Stripe, Zapier and any server by URL. Add or drop any? Ship Stripe as look-up only at first, since its changes (refunds) are powerful even with approval? | Keep the list; open question on Stripe left to the owner, with look-up only as the cautious start. | M13 Q7 | Keep the list; Stripe ships look-up only at first. (2026-10-20) |
| D-18 | Vendor developer accounts to verify each catalog connect flow: a release gate, or recorded later as in M11? | Owner's call; M11's precedent was "not a blocker, recorded later". | M13 Q8 | Not a release gate; real-account runs recorded later, as in M11. (2026-10-20) |

## M14 Inbox productivity

Plan: [M14-inbox-productivity.md](../in-development/M14-inbox-productivity.md).

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-19 | How does snooze interact with SLAs? | Pause the resolution clock only; response clocks keep running, and an SLA warning wakes the ticket. Alternatives: pause both clocks (what a `pauses_sla` status does today), or neither. | M14 Q1 | Pause the resolution clock only. (2026-10-20) |
| D-20 | Snooze as a status or as a flag? | A seeded Snoozed status. A flag that leaves the status alone needs a new pause rule and hides snooze from reports. | M14 Q2 | Accepted as recommended. (2026-10-20) |
| D-21 | Severity as a first-class field? | No. Ship M14-16 (custom-field filters and a pinned field chip) and the Severity recipe in the guide. Sev 1–4 as a field would add about 4 days with rules, views, API, importers and webhooks. | M14 Q3 | No first-class field; custom-field recipe (M14-16). (2026-10-20) |
| D-22 | Bulk change failure mode. | All or nothing against a preview. The alternative commits what it can and reports the rest. | M14 Q4 | All or nothing against a preview. (2026-10-20) |
| D-23 | Allow macros without a reply in bulk changes? | Not in M14. | M14 Q5 | Accepted as recommended. (2026-10-20) |
| D-24 | Satisfaction surveys after a bulk close. | Sent as for any close, after the 60-second undo window. The alternative, a "Don't send surveys" box, changes DOMAIN-RULES §2.2. | M14 Q6 | Accepted as recommended. (2026-10-20) |
| D-25 | Default notification email schedule after the upgrade. | *Right away* (batched) for everyone, replacing one email per notification. | M14 Q7 | Right away (batched) for everyone. (2026-10-20) |
| D-26 | Notification digests per brand? | Yes. A single cross-brand digest needs an audited all-brands system path. | M14 Q8 | Accepted as recommended. (2026-10-20) |
| D-27 | How long to hold a right-away email while the recipient is online? | At most 15 minutes. Holding indefinitely while someone is in the app would mean a tab left open all day gets no email. | M14 Q9 | Accepted as recommended. (2026-10-20) |
| D-28 | Include the photo upload in the customer-facing profile (2 of M14-12's 5 days), or defer and use initials? | Owner's call. M19-03's team faces need the photo. | M14 Q10 | Include the photo upload in M14-12. (2026-10-20) |
| D-29 | The widget always files into the brand's first department. Add a per-brand widget department setting (about 1 day, in M14-09), or leave it to the widget work? | Leave it to M19-02, which gives each widget its own department default; Test routing makes today's behaviour visible meanwhile. | M14 Q11 | Accepted as recommended. (2026-10-20) |
| D-30 | Are API-key closes refused while a required-to-close field is empty? | Yes, as for people (an integration closing tickets acts for a person); rules and time-based closes go through with an activity note. | M14 Q12 | Accepted as recommended. (2026-10-20) |
| D-31 | Who sees the setup checklist? | Admins only. Team Leaders could see the steps they can do. | M14 Q13 | Accepted as recommended. (2026-10-20) |
| D-32 | Single-key shortcuts on or off by default? | On (today's behaviour), with the switch. Off would be safer for screen-reader users and worse for everyone else. | M14 Q14 | Accepted as recommended. (2026-10-20) |

## M15 Self-host operations

Plan: [M15-self-host-operations.md](../in-development/M15-self-host-operations.md).

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-33 | Host `install.sh` only on GitHub releases, or also on a project domain? A domain is shorter to type but adds DNS and TLS to trust. | GitHub releases only for now. | Q15-1 | Accepted as recommended. (2026-10-20) |
| D-34 | Automatic updates off by default, with "patch" the only level offered at first? | Yes; "minor" follows after two clean releases. | Q15-2 | Off by default, patch level only. (2026-10-20) |
| D-35 | Encrypted backups: add `age` as an optional host tool, or document "encrypt the directory with your own tool"? | Document it now and revisit later. | Q15-3 | Accepted as recommended. (2026-10-20) |
| D-36 | Is an air-gapped install a 1.x requirement? It adds the trusted-root export step and its tests. | Owner's call. | Q15-4 | Not a 1.x requirement; offline install documented as manual. (2026-10-20) |
| D-37 | Sample data content: written by the maintainer or contributed? | Either, reviewed in both languages. | Q15-5 | Either, reviewed in both languages. (2026-10-20) |
| D-38 | Who may add or remove the sample brand? | An install admin adds it; its own brand admin may remove it. | Q15-6 | Accepted as recommended. (2026-10-20) |
| D-39 | Which release introduces the Changesets front-matter keys for `security` and `autoUpdate`? | Owner's call; the release guide changes either way. | Q15-7 | Introduce the `security` and `autoUpdate` keys with M15, in 1.2. (2026-10-20) |

## M16 More importers and undo

Plan: [M16-more-importers-and-undo.md](../in-development/M16-more-importers-and-undo.md).

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-40 | Undo for runs made before the undo ledger exists. | Allow chain-level undo of tickets and articles only. The alternative is no undo for those runs. | Q16-1 | Accepted as recommended. (2026-10-20) |
| D-41 | Is there a time limit on undoing an import? | None, with a warning when the run is older than 30 days. | Q16-2 | Accepted as recommended. (2026-10-20) |
| D-42 | Do kept tickets stay linked to their source after an undo? | Yes, so a later import updates them and never duplicates them. | Q16-3 | Accepted as recommended. (2026-10-20) |
| D-43 | Offer "Keep the connection for 30 days" for "Bring over changes" at all? | Yes, opt-in, encrypted and swept; re-pasting credentials stays the default. | Q16-4 | Accepted as recommended. (2026-10-20) |
| D-44 | Import automations from Zendesk and Freshdesk only in this milestone, or from all sources? | Zendesk and Freshdesk only. | Q16-5 | Accepted as recommended. (2026-10-20) |
| D-45 | Connector order if capacity is short. | Help Scout, Intercom, Front, Zammad, Gorgias. | Q16-6 | Accepted as recommended. (2026-10-20) |

## M17 Apps and languages

Plan: [M17-apps-and-languages.md](../in-development/M17-apps-and-languages.md). The split from M20 is D-02.

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-46 | Wave 1 customer-facing locales: `fr`, `es`, `de`, `pt-BR`, `tr`, `id` and `fa`? Is Urdu or Hebrew wanted early (RTL), or Hindi and Bengali? | The seven listed; `fa` proves the RTL work beyond Arabic. | Q17-2 | fr, es, de, pt-BR, tr, id and fa. (2026-10-20) |
| D-47 | Translation platform: Hosted Weblate (free for libre projects), a self-hosted Weblate, or pull-request-only translation? | Hosted Weblate (ADR 0048). | Q17-4 | Hosted Weblate. (2026-10-20) |
| D-48 | Offer locales below 100 % to brands as "beta", or hide them until complete? Is paid translation acceptable for wave 1? | Owner's call; "beta" at 90 % or more with English fallback is the plan's option. | Q17-5 | Offer as beta at 90 % or more, with English fallback. (2026-10-20) |
| D-49 | Does IBM Plex Sans Arabic cover Persian and Urdu well enough to stay their default face, or should Vazirmatn (already in DESIGN §8's curated list) become the admin default for `fa`? | Verify coverage first; Vazirmatn is the fallback choice. | Q17-6 | Accepted as recommended. (2026-10-20) |

## M18 Sign-in options

Plan: [M18-sign-in-options.md](../in-development/M18-sign-in-options.md).

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-50 | May a fresh passkey assertion replace a fresh TOTP code for break-glass under SSO enforcement (ADR 0053, amending ADR 0026)? | Yes. | M18 Q1 | Yes. (2026-10-20) |
| D-51 | Should the built-in proof-of-work provider become the default when an admin turns CAPTCHA on, with Turnstile as the stronger option (ADR 0052, amending ADR 0003)? | Yes, for new brands only. | M18 Q2 | Yes, for new brands only. (2026-10-20) The one exception, a 1.0 brand that turned the check on without saving a provider and so had a non-working check, moves to `pow` with no migration: accepted by the owner on 2026-10-20 (ADR 0052). |
| D-52 | Allow personal Microsoft accounts (`allowConsumers`) at all? | Off by default. | M18 Q3 | Accepted as recommended. (2026-10-20) |
| D-53 | GitHub organisation restriction (`read:org` scope) in M18 or later? | Later. | M18 Q4 | Accepted as recommended. (2026-10-20) |
| D-54 | Allow a passkey instead of a password at invitation acceptance (fully passwordless accounts from day one), +1 day in M18-04? | Owner's call. | M18 Q5 | Not now; password at invitation, passkey added after. (2026-10-20) |
| D-55 | A "require phishing-resistant MFA for Admins" setting: backlog or M18 (+1.5 days)? | Owner's call. | M18 Q6 | Backlog. (2026-10-20) |

## M19 Customer surfaces polish

Plan: [M19-customer-surfaces-polish.md](../in-development/M19-customer-surfaces-polish.md).

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-56 | Is the Custom HTML email layout wanted, or only the Simple mode (lower risk)? | Owner's call; Custom HTML runs behind the existing sanitiser (ADR 0055). | CS-Q1 | Both: Simple and Custom HTML behind the sanitiser. (2026-10-20) |
| D-57 | Team faces in the widget off by default for every staff member? | Yes; each person opts in. | CS-Q2 | Accepted as recommended. (2026-10-20) |
| D-58 | Several widgets per brand, or several brands as today's answer? The data-model change is the expensive part. | Owner's call; M19-02 and ADR 0054 assume several widgets. | CS-Q3 | Several widgets per brand (M19-02, ADR 0054). (2026-10-20) |

## M20 Native clients and SDKs

Plan: [M20-native-clients-and-sdks.md](../in-development/M20-native-clients-and-sdks.md).

| Id | Question | Recommendation | Source | Answer |
|---|---|---|---|---|
| D-59 | Will the project pay for an Apple Developer ID (99 USD a year) and Windows signing (Azure Trusted Signing, about 10 USD a month)? Without them the desktop app warns on install and macOS will not update it automatically. | Owner's call; unsigned builds are labelled until then. | Q17-3 | Not yet; ship unsigned builds, clearly labelled. (2026-10-20) |
| D-60 | Flutter SDK: build it in-house (16 days) or invite the community with the conformance kit (about 4 days of review)? | Community-led with maintainer review. | Q17-7 | Community-led with maintainer review. (2026-10-20) |
| D-61 | Licence of the client SDKs and `@helpdock/widget-client`. AGPL in a customer's mobile app is an adoption barrier; MIT or Apache-2.0 for the client SDKs only, with the server staying AGPL, is common practice. | MIT for the SDKs. | Q17-8 | MIT for the client SDKs only; the server stays AGPL. (2026-10-20) |

## Prior-art gap check

On 2026-10-20 the plans were checked against a full walk through another open-source helpdesk's admin and agent screens (OpenDesk, Apache-2.0): every settings tab, every "New…" form and the ticket screen. Each item was checked against Helpdock 1.0 (code and guides) and the plans above. Items Helpdock already has or already plans need no answer; the additions were made in the plans named; the declined items are listed with the reason, and the owner may overrule any of them.

**Added to the plans**

| Item | Where | Effort |
|---|---|---|
| Rewrite longer, fix spelling and grammar, simpler; draft a reply with a one-line instruction | M12-17 | 1.5 d |
| Persona reply length (short, medium, detailed) | M12-02 | +0.5 d |
| API key expiry in the admin (the API already accepts `expiresAt`) | M13-11 | +0.5 d |
| Notification sounds per event, with a reminder while a live chat waits | M14-25 | 2 d |
| Views filtered by mailbox and by the address written to; rule conditions on both; rule actions "set reply address" and "mark as spam" | M14-26 | 3 d |
| Custom field types long text, link, email and person | M14-27 | 2.5 d |
| More webhook events: ticket assigned, status changed, merged; message created; contact updated and merged; account created and updated | M14-28 | 3 d |
| Reports: volume by tag, and current backlog by status with its unassigned share | M14-29 | 2 d |
| Downloadable CSV templates for the manual mapper, including one row per message | M16-15 | 1 d |
| Email footer with placeholders, a satisfaction email editor that requires the survey link, a variables reference with sample values | M19-01 | +1 d |
| Quoted history in reply emails (previous public message or none, notes never) with a quote-line template | M19-10 | 2 d |
| A warning when a published article's slug changes, and a permanent redirect from the old address | M19-05 | +1 d |

**Already in Helpdock 1.0 or already planned**

Light, dark and system appearance in the admin (`ThemePreference`); merge into another ticket and copy link on the ticket; sort by SLA due (M14-07) and snooze presets (M14-02); list filters by priority, channel and tag; the bulk bar (M14-04); fields required to close (M14-17); custom fields on tickets, contacts and accounts; shared views; SLA policies with business hours; rules with time-based triggers; the crawl's page limit, include and exclude patterns, `robots.txt` and daily or weekly re-crawl; per-agent figures in Reports' Agent workload card, with median and p90 response times; article descriptions; categories and sections for the knowledge base; drafting one article from several tickets (M12-16); a playground that answers as another model or persona (M12-04) and tests with a signed-in visitor (M13-08); MCP servers with no auth, a bearer token, a header or OAuth (M13-06, M13-08); custom help-center domains with automatic HTTPS; passkeys named per device (M18); past tickets on the contact card (shipped in 1.0).

**Declined, with the reason**

| Item | Reason |
|---|---|
| A template logic language (conditions, loops, filters) in email layouts and replies | A second rendering engine in customer-sent mail is a template-injection surface; one pass over a fixed list of placeholders with fallbacks (M14-14) covers the common cases |
| A sentiment condition in rules | M12-11's AI yes/no question ("Is the customer upset?") covers it, budgeted and logged, without a second classifier |
| A realtime subscription scope on API keys | Webhooks are the push path for integrations; a key-authenticated socket is a new public surface. Backlog if asked |
| Webhook events for configuration objects (tags, mailboxes, staff, views, rules, SLA policies, teams, canned responses) | Configuration changes are in the audit log; pushing them to third parties widens what leaves the install for little use |
| A "fastest first reply" figure and an agent leaderboard | Median and p90 are reported, and the Agent workload card already shows per-agent figures; a minimum is noise and a ranking invites the wrong incentives |
| Private teams | Departments are the privacy boundary, enforced in the database (M14 non-goal) |
| Label groups, one-label-at-a-time groups, labels on contacts and companies | Tagging work for a ticketing-settings plan; kept in the backlog (PRD §5) |
| A generated bot face, emoji faces, an emoji amount setting | DESIGN.md allows no emoji; a persona's avatar is an uploaded image (M12 non-goal) |
| HTML and CSV file uploads as knowledge | The crawl covers HTML pages; CSV is tabular and chunks poorly. Backlog if asked |
| A separate step-by-step mailbox wizard | The mailbox form already tests IMAP and SMTP, and the setup checklist (M14-13) leads to it |
| A Severity field | D-21: custom-field filters and a pinned field chip instead (M14-16) |
| Pronouns on the agent profile | Rarely used and awkward in Arabic grammar (M14-12); open to adding later |
