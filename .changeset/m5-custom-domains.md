---
'@helpdock/api': minor
---

Custom help center domains (M5-07). Brand › Domains adds a brand's own host name, shows the CNAME and TXT records to publish with copy buttons, and says what the last check saw: waiting for DNS, verified with the certificate issued, or failed with the reason. The worker checks DNS on request and every fifteen minutes, verifies a domain once it sees both records, makes one TLS handshake so Caddy issues the certificate before a customer asks, and un-verifies a domain whose TXT record is gone. A domain can be flagged "Proxied by Cloudflare", in which case Caddy issues nothing for it. `/internal/domain-check` answers 200 only for a verified, unproxied help center domain, and verified hosts now route to their brand. Brand › General edits the brand's name, default language and time zone. New optional setting: `HELPCENTER_CNAME_TARGET`.
