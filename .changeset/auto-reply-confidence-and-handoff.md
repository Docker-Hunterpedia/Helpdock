---
"@helpdock/api": patch
---

Auto-reply hands off what the knowledge base does not answer, and stops handing off answers it does (M7-06, DOMAIN-RULES §9). The model now replies `NO_ANSWER` when its sources do not answer the customer's exact question, instead of saying it is not sure and offering related facts, and the conversation goes to the team. Its `CONFIDENCE:` figure is read whether it is on a line of its own or run on from the last sentence, and whatever its Markdown emphasis or case (`**Confidence:** 0.9`); a missing figure still counts as 0 and hands off. The rules end with the reply format and an example, so the figure is written more reliably.
