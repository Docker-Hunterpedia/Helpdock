---
"@helpdock/api": minor
---

Profile for customers (M14-12): a Profile tab on Your account with a public name, job title in English and Arabic, phone, photo and time zone. Customers see the public name (the first name until one is set) in the widget, on email replies, in the survey and on the Meta channels, never the full name or an email address. Photos are sniffed, cropped and re-encoded to 256 and 64 px WebP and served by five-minute presigned links; the widget draws them with the agent's job title. Replies and signatures gain `{{agent.name}}`, `{{agent.full_name}}`, `{{agent.title}}`, `{{agent.phone}}` and `{{department.name}}`. `GET`/`PATCH /api/me/profile` gain the new fields, `POST`/`DELETE /api/me/profile/photo` are new, and the widget's agent gains `title`. The daily digest and the snooze presets read the person's own time zone.
