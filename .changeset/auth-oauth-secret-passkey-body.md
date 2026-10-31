---
"@helpdock/api": minor
---

Google and GitHub sign-in buttons are now drawn only when both a client id and a client secret are set, as Microsoft's already was, so a missing secret no longer fails after the consent screen. The passkey routes (`/api/auth/passkey/*`, `/api/auth/enrolment/passkey/*`, `/api/me/passkeys*`) now refuse bodies over 64 KiB with 413.
