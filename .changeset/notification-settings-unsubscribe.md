---
"@helpdock/api": minor
---

Notification settings and one-click unsubscribe (M14-11): the Email schedule card on Your account › Notifications (Right away, hourly or daily digest at an hour, Off; Pause; Send me a test email), a status line there and in the bell's panel, and an Urgent caption in the matrix. Every notification email carries `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058) and a footer link to a confirmation page at `/unsubscribe/<token>`. The token is signed, purpose-bound and valid for a year; a `GET` changes nothing, the `POST` unsubscribes idempotently and is audited. New: `GET`/`POST /api/public/unsubscribe/:token`, `POST /api/brands/:brandId/notifications/test-email`, `emailUnsubscribed: false` on `PUT /api/me/notification-preferences`, and `emailConfigured` and `digestTimeZone` in its view.
