---
"@helpdock/api": patch
---

A stored secret is no longer sent to a destination it was not saved for (#399). An IMAP mailbox's password (save and Test IMAP), an AI provider's API key, the embeddings and transcription API keys and an OIDC client secret are reused by a save that sends none only while the IMAP host, port, username and TLS mode, the provider kind and base URL, the embeddings base URL, the transcription endpoint, or the OIDC issuer are unchanged. Otherwise the call is refused with 400 (`password-required`, `credential-required`, `embedding-key-required`, `transcription-key-required`, `sso-client-secret-required`) and a field error on the secret, nothing is stored, and no connection is opened; the admin forms open the secret field and say so on it.
