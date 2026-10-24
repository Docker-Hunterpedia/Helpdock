---
"@helpdock/api": minor
---

An install admin can now reset another person's second factor (#398). From the Staff row menu, after confirming it is them, the admin removes the person's authenticator app, passkeys and recovery codes in one transaction: every session is revoked, `auth.second_factor.reset` is audited, and the person is emailed through the outbox. At their next sign-in they enrol again, as a newly promoted Admin does. Refused for your own account, when the factors changed while the confirm was open, and for the last break-glass admin while SSO is enforced; ten resets an hour per admin.
