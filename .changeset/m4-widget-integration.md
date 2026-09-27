---
'@helpdock/api': minor
---

The chat widget now works end to end (M4-01, M4-04, M4-06). The api serves `widget.js`, its lazy chunks and its fonts from `WIDGET_DIST_DIR` (the image sets it), so a site embeds it with the one tag Channels › Widget shows: `<script type="module" src="…/widget.js" data-brand="…">`. The widget's real transport talks to the widget API over REST, the `/widget` socket and the SSE fallback, in a lazy chunk that keeps `widget.js` near 25 KB gzipped; it notices a dropped network at once and, when it is back, sends what was waiting and catches up on what it missed. The widget config now carries the brand's resolved theme for light and dark, the greeting and field labels in the visitor's language, the contact form's fields, the help center link and the popular-articles list, and a conversation can be opened before its first message, idempotently, which the pre-chat and contact forms use.
