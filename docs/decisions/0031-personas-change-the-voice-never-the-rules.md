# 0031 Personas change the voice, never the rules; avatars are public uploads

Status: proposed
Date: 2026-10-20

## Context

In 1.0 a brand's assistant has one system prompt (`system_prompt`,
`system_prompt_ar`) and one handoff message in `ai_settings.modes`. Brands want
the assistant to have a name, a face and a tone, and want different channels
(the widget, a mailbox, a Telegram bot) to answer in different voices. A
persona must not become a way to weaken grounding, hide that an answer is from
AI, or bypass guardrails. DESIGN.md allows no emoji anywhere (§5) and no
decoration that carries no information (§1).

M12-03 ([plan](../in-development/M12-ai-workspace.md)) adds personas.

## Decision

1. Up to 10 personas per brand (`ai_personas`): name, avatar, tone, greeting,
   handoff and decline lines in `en` and `ar`. One is the brand default; the
   1.0 handoff message migrates into it.
2. Assignment per channel (`ai_persona_assignments`): the widget, each mailbox,
   each Telegram bot. Meta accounts have no auto-reply and no persona. When
   several widgets per brand arrive (M19-02), each widget picks its persona.
3. A persona sets the name and avatar the customer sees, the tone, the greeting
   and the handoff and decline lines. It never changes the knowledge, the
   audience, the threshold, the guardrails, the budget or the channel's mode.
   In prompt assembly the persona's tone comes after Helpdock's fixed rules, so
   it cannot switch a rule off (DOMAIN-RULES §17.2, proposed).
4. Every message a persona sends carries the AI badge in words. No setting
   hides it. A sent message keeps the persona it was sent as.
5. Avatars are uploaded images: magic-byte sniffing (ADR 0009), sharp re-encode
   to 256 px WebP, EXIF stripped, stored in the public prefix beside help
   center images. With no upload, the default Sparkles tile. No face builder,
   no emoji faces, no animated avatars.
6. On email the AI reply signs with the persona name; the `From` name stays the
   department's (owner decision D-10). On Telegram the bot's name stays
   Telegram's.

## Consequences

- Brands get a voice per channel without a second prompt or a second set of
  rules; the eval runs the answerable set with a persona and must keep the same
  threshold (≥ 85 %).
- Persona avatars are the only new public objects; they contain nothing
  personal.
- A persona in use cannot be deleted (foreign key `on delete restrict`); the
  default cannot be deleted.
- The widget config gains `assistant.persona { name, avatarUrl, greeting }`,
  recorded in the widget protocol.

## Alternatives considered

- **A face builder or emoji avatars**: against DESIGN.md §1 and §5.
- **Personas that carry their own instructions or knowledge**: would let a
  persona change the rules, and would make tests and the eval measure a
  different assistant per channel.
- **Letting a persona name replace the AI badge**: hides that an answer is from
  AI, which the product never does (and which EU AI Act Article 50
  transparency also asks of systems that talk to people).
