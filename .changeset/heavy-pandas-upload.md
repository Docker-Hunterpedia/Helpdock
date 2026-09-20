---
'@helpdock/api': minor
---

Attachments and the media pipeline (M1-10). A ticket can now carry files:
`POST …/attachments/presign` issues a five-minute upload URL bound to one
object, one content type and one exact length; `confirm` checks the object
against the brand's content policy and enqueues `media.process` through the
outbox; the worker sniffs the magic bytes, re-encodes images to WebP with two
thumbnails and no EXIF, normalises voice notes to Opus, takes a video poster,
optionally scans files with ClamAV, and marks the row `ready`. Downloads are
presigned for five minutes and issued only from a row the caller's transaction
can see, so authorisation is the parent ticket's. `POST …/messages` accepts
`attachmentIds` and links them in the same transaction as the message. The admin
app gains the client helper the M1-15 composer will use; there is no screen yet.
