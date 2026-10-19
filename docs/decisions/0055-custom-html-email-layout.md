# 0055 A custom HTML email layout behind the existing sanitiser

Status: proposed
Date: 2026-10-20

## Context

Replies, auto-replies and the satisfaction email use one fixed layout.
Auto-responder templates are subject and plain text per locale with `{{…}}`
placeholders ([outbound-email guide](../guides/outbound-email.md)). Brands want
their replies to look like the brand, and some want full control of the
layout. Email HTML is a hostile environment: scripts, forms and remote content
are tracking or attack vectors, and clients render CSS inconsistently. Helpdock
already sanitises email HTML with an allow-list (M2-07,
[ADR 0007](0007-html-sanitizer.md)).

Planned in [M19 Customer surfaces polish](../in-development/M19-customer-surfaces-polish.md)
(M19-01). Whether Custom HTML is offered at all, or only the Simple mode, is
owner decision D-56.

## Decision

1. An email design editor per brand with two modes:
   - **Simple:** logo on or off, accent from the brand token, a font from the
     DESIGN §8 curated list, footer text per locale, Plain or Branded layout.
   - **Custom HTML:** one layout template with `{{content}}`, `{{signature}}`
     and `{{brand.*}}` slots.
2. A custom template passes the **existing M2-07 email sanitiser** on save and
   again on render: no scripts, no forms, no remote fonts or remote content, no
   free-form CSS beyond what the sanitiser allows. Templates are size-capped.
3. A template that fails validation is refused on save, and the **Plain layout**
   is used if one ever fails at render time.
4. Every send carries a text alternative generated from the HTML. A test send
   goes to the editor's own address only, through the outbox.

## Consequences

- Brands can match their own look without Helpdock rendering untrusted markup.
- Some layouts will render differently across mail clients; the preview at
  desktop and mobile widths and the test send are the checks.
- The sanitiser becomes a security boundary for brand-authored layouts as well
  as for inbound mail, so its tests grow template cases.

## Alternatives considered

- **Simple mode only:** lowest risk; leaves brands that need a specific layout
  without one.
- **Free-form HTML and CSS with remote assets:** tracking pixels and remote
  fonts in staff-authored mail, and a much larger attack surface.
- **A drag-and-drop block builder:** a large new component for a first version.
