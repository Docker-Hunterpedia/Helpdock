---
"@helpdock/api": patch
---

**Widget visitors behind a proxy.** The `/widget` socket handshake keyed its per-address budget (300 per 5 minutes per brand) on the proxy's address, so behind Caddy every visitor of a brand shared one budget and one busy visitor could lock the others out of live chat. The handshake now resolves the visitor's address from `X-Forwarded-For` under the same `TRUST_PROXY` rule as `request.ip`: only from a proxy the setting names, and never with `TRUST_PROXY=false`. Nothing to change in your configuration.
