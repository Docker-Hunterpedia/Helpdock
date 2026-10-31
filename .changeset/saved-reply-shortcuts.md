---
"@helpdock/api": minor
---

Saved replies and macros gain a shortcut: type `/refund` in a reply, at the start of a line or after a space, and press Tab or Enter to insert it. A shortcut is unique where the item is offered and a taken one is refused. `{{contact.first_name|there}}` renders a fallback for an empty value, a reply with an unknown placeholder or an unclosed `{{` is refused on save with each one named, `{{` in the composer lists the placeholders this ticket can fill, and the picker puts your own and the most used items first (`use_count`, migration 0074).
