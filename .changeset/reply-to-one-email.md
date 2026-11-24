---
'@helpdock/api': minor
---

Reply to one email of a ticket (M14-31). A Reply button on each email a customer sent opens the composer on a "Replying to" strip; the server quotes that email under the reply and sets `In-Reply-To` and `References` to it. The public reply request takes an optional `replyToMessageId`, and messages carry it back.
