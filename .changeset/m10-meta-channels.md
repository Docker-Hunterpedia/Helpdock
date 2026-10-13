---
'@helpdock/api': minor
---

WhatsApp numbers, Facebook Pages and Instagram professional accounts are ticket channels (M10, the Meta channels guide). Admins connect an account per platform on Channels › Meta by pasting its token, test it before saving, see its health and reconnect it when Meta drops the token or the subscription. A customer's message opens or continues a ticket. An agent's reply goes back on the same platform inside Meta's reply window, and a reply outside the window is refused when it is written. A person's reply to a Messenger or Instagram customer between 24 hours and 7 days goes out with Meta's Human Agent tag when the account's switch is on. Migrations `0050_meta_channels`, `0051_meta_profile_checked` and `0052_meta_deliveries_platform_ids` add the Meta tables, the three channel kinds and an index for delivery reports. WhatsApp templates come in a later release.
