# 0008 Normalise phone numbers in-house, international format only in v1

Status: accepted
Date: 2026-09-19

## Context

A contact is one person because `contact_identities` is unique on `(brand_id, kind, value)` ([DOMAIN-RULES §4.4](../planning/DOMAIN-RULES.md#44-contact-merge)). The index compares the *spelled* value, so every spelling of one identifier has to be reduced to the same string before it is stored. For an email address that is trimming and lower-casing. For a phone number it is a much bigger question: `+49 30 1234 567`, `0049-30-1234567`, `030 1234 567` and `+٤٩٣٠١٢٣٤٥٦٧` may all be the same number, and only the first two say so without knowing where the caller is.

The full answer is E.164, and the full answer needs a database: which country codes exist, how long a national number is in each of them, which national prefix to strip. `libphonenumber-js` carries that database. Weighed against it:

- **A phone number is never verified in v1.** DOMAIN-RULES §4.4 puts "Phone · Never in v1 · No" in the table: Helpdock sends no SMS, so nothing can prove a number and nothing auto-merges on one. A phone number is a label an agent reads and dials, not a credential and not a join key that has to be exactly right.
- **The value is normalised in three places**, and one of them is the widget. `packages/schemas` is imported by `apps/widget`, whose size budget is the tightest constraint in the product ([REQUIREMENTS §4.6](../planning/REQUIREMENTS.md#46-live-chat-widget)). `libphonenumber-js` states its metadata bundles as 80 KB for `/min` (length validation only), 95 KB for `/mobile` and 145 KB for `/max`; the metadata is the bulk of each and cannot be tree-shaken below the region set it covers.
- **A dependency outside the stack table needs an ADR anyway** (AGENTS.md), and this is the decision that ADR would have to justify.
- **Telephony is where a wrong guess is expensive.** Prefixing a default country code onto a number that was already international, or onto a number from another country, produces a working number belonging to somebody else. Refusing is recoverable; dialling a stranger is not.

## Decision

Normalise phone numbers in `packages/schemas/src/contact.ts`, with no dependency, by a deliberately narrow rule:

1. Arabic-Indic (`٠١٢…`) and Eastern Arabic-Indic (`۰۱۲…`) digits become Latin, then separators — spaces, non-breaking spaces, hyphens, dots, brackets, slashes, the Arabic thousands separator — are removed.
2. A leading `00` becomes `+`.
3. With a leading `+`, the rest must be 7 to 15 digits (E.164's own limits) and the result is `+<digits>`.
4. Without one, the brand's `contacts.defaultCallingCode` setting is prefixed and a leading national trunk `0` is dropped. **With no such setting the number is refused**, with the code `phone-not-international`, and the screen asks for the number in international form.

It does not know which country codes exist, how long a national number is, or how to format one for display. **International format only in v1.**

## Consequences

- `@helpdock/schemas` stays dependency-free apart from Zod, and the widget's size budget is untouched.
- An install that supports one country sets `contacts.defaultCallingCode` once and agents may type national numbers. An install that supports several leaves it empty and is asked for `+`, which is the honest answer rather than a guess.
- `+49 30 12` is accepted, because nothing here knows that a German number is longer than that. A typo that keeps 7 to 15 digits is stored as typed. That is a display and dialling annoyance; it is not an identity error, because nothing merges on a phone number.
- Display formatting (`+49 30 1234 567` rather than `+49301234567`) is not offered. Adding it means the metadata this ADR declined.
- The rule is one pure function with a unit test per spelling, so a channel that starts collecting phone numbers cannot disagree with the admin about what one is.
- If v1.1 adds SMS, a verified phone number becomes a join key and this decision has to be revisited: at that point `libphonenumber-js` on the server alone — never in the widget — is the likely successor, recorded as a new ADR.

## Alternatives considered

- **`libphonenumber-js` (`/min`, 80 KB).** Correct, maintained, and what every serious product uses. Rejected for v1 because the value it adds — knowing a national number's length and its country's prefix rules — matters most for a verified identifier, and there is no verified phone number in v1; and because the package would ship in the widget bundle, where even the 80 KB `/min` bundle is a large fraction of the whole budget.
- **`libphonenumber-js/max` (145 KB) or `google-libphonenumber`.** Larger still, for digit-level validation and the mobile-versus-landline distinction that nothing in v1 reads.
- **Store the number exactly as typed.** Rejected: `+49 30 1234 567` and `+49301234567` would be two identifiers, so one person would become two contacts, which is what M1-04 exists to prevent.
- **Guess the country from the brand's timezone.** Rejected as the worst option: a timezone is not a dialling plan, and a silent wrong guess produces a valid number belonging to somebody else.
