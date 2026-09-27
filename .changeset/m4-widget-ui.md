---
'@helpdock/api': minor
---

The chat widget's interface (M4-01, M4-05 to M4-08, M4-11). `widget.js` is a Preact app in a Shadow DOM, embedded with one `<script type="module" data-brand>` tag and a `Helpdock('identify', …)` call for signed identity; a size check keeps the entry under 40 KB gzipped and each lazy chunk under 20 KB. It draws the four modes (chat, chat with suggested articles, help center, contact form), the brand theme in light, dark or auto, and Arabic right to left; the pre-chat form, queue position, out-of-hours notice with the next opening, agent name and avatar, typing, and the transcript request; attachments within the brand's content policy and voice messages recorded in the browser; and the delivery states (sending, sent, seen, not sent with Retry) with catch-up after a reconnect. It is keyboard-operable, announces the thread as a live log and uses 44 px targets throughout.
