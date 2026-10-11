---
'@helpdock/api': patch
---

Agent assist now sends a brand's Arabic system prompt for an Arabic ticket, as auto-reply already did. Until now every assist task (suggest reply, summary, suggested fields, translate, rewrite, draft article) sent the main prompt, so a brand that wrote its tone and language policy in Arabic saw it ignored in assist. The ticket's language is that of the customer's last message; a brand with no Arabic prompt is unaffected.
