# Attachments and the media pipeline

What a brand allows in a message, how an upload gets from a browser into object
storage, what the worker makes of it, and how it is served back. Specified by
[REQUIREMENTS §4.6](../planning/REQUIREMENTS.md#46-live-chat-widget) (the
content policy) and [§5.1](../planning/REQUIREMENTS.md#51-security-non-negotiable)
(uploads), [ARCHITECTURE §9](../planning/ARCHITECTURE.md#9-media-pipeline) (the
pipeline) and [DOMAIN-RULES §4.5](../planning/DOMAIN-RULES.md#45-attachments)
(who may reach an object). Implemented by M1-10.

There is no composer yet. The admin's ticket view is M1-15; this describes the
api and the client helper it will be built on.

## The shape of it

```
browser                api                     S3 / MinIO            worker
   │                    │                          │                    │
   ├─ presign ─────────▶│ policy check, row        │                    │
   │◀──── url + headers │ (status = pending)       │                    │
   ├─ PUT ─────────────────────────────────────────▶ object             │
   ├─ confirm ─────────▶│ HEAD, policy again,      │                    │
   │                    │ status = processing      │                    │
   │                    │ + outbox row ────────────────────────────────▶│
   │                    │                          │◀─ download, sniff ─┤
   │                    │                          │◀─ variants ────────┤
   │◀─ attachment:changed ──────────────────── outbox ◀─ status = ready ─┤
   ├─ GET ?variant= ───▶│ presigned GET (5 min)    │                    │
   └─ GET ─────────────────────────────────────────▶ bytes              │
```

Three rules run through all of it.

**A claim is not evidence.** The size and the MIME type at presign are what the
client says it is about to send. They are signed into the upload URL, checked
against the stored object at confirm, and checked a third time against the
object's magic bytes in the worker.

**The bucket is private.** Nothing sets an ACL and no response carries a bucket
URL. Every byte a client reads comes through a presigned GET this api issued
after authorising the caller on the parent ticket.

**Authorisation is the parent ticket's.** `attachments` is a department-scoped
tenant table, so an attachment on a ticket the caller cannot read is invisible
to the query that would have built the URL. There is no separate check to
forget.

## The content policy

Per brand, stored in `brands.content_policy` as jsonb and edited by a Team
Leader. Every field has a default, so `{}` parses into the shipped policy and a
brand created before a kind existed needs no backfill.

```jsonc
{
  "text": true,
  "emoji": true,
  "image": { "enabled": true, "maxBytes": 10485760, "allowedMime": ["image/webp", "image/jpeg", "image/png", "image/gif"] },
  "video": { "enabled": true, "maxBytes": 52428800, "allowedMime": ["video/mp4", "video/webm"] },
  "voice": { "enabled": true, "maxBytes": 5242880,  "allowedMime": ["audio/ogg", "audio/webm", "audio/mp4"] },
  "file":  { "enabled": true, "maxBytes": 26214400, "allowedMime": ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/plain", "application/zip"] },
  "maxAttachmentsPerMessage": 5,
  "keepOriginals": false
}
```

| Field | Meaning |
|---|---|
| `text`, `emoji` | Plain switches; no size or type to configure. |
| `image`, `video`, `voice`, `file` | On or off, a byte cap, and the MIME types accepted. |
| `maxAttachmentsPerMessage` | Enforced when the message is sent, not when a file is uploaded. |
| `keepOriginals` | Keep the bytes that were uploaded beside the re-encoded copy. Off by default, because re-encoding exists to get rid of them. |

An upload's **kind** decides which half of the policy applies: `audio` reads
`voice`, because REQUIREMENTS §4.6 calls the control "voice messages" and the
pipeline calls the bytes audio.

Two bounds a brand cannot raise: `maxBytes` may not exceed 200 MiB and
`maxAttachmentsPerMessage` may not exceed 20. And a brand may only allow a MIME
type the pipeline can verify — see the sniffing table in
[ADR 0009](../decisions/0009-magic-byte-sniffing.md) — so `image/svg+xml` and
`text/html` cannot be enabled at all.

## Storage layout

```
brands/<brandId>/tickets/<ticketId>/<attachmentId>/<variant>
```

Every segment is a uuid this api generated or a variant name from a closed set.
Nothing a caller typed reaches the bucket's namespace, so `../`, a NUL byte and
a filename that is really a path cannot appear in a key. The uploaded name is
kept in a column, stripped of any path, and used only in the
`Content-Disposition` of a download.

The prefixes nest — brand, then ticket, then attachment — which is what makes
the purges in [DOMAIN-RULES §11](../planning/DOMAIN-RULES.md#11-data-lifecycle)
one list and one delete loop: a closed ticket's attachments are contiguous, and
so are a deleted brand's.

## Variants

| Kind | Written | `original` kept |
|---|---|---|
| `image` | `webp` (max 2048 px, quality 82), `thumb320`, `thumb960` | only with `keepOriginals` |
| `audio` | `opus` (Ogg, 48 kHz mono, 32 kbps) | only with `keepOriginals` |
| `video` | `poster` (WebP frame at 1 s) | always — v1 does not transcode video |
| `file` | nothing | always |

`attachments.variants` records every object that exists, including `original`
when it was kept, each with its content type, byte size and — where it applies —
dimensions and duration. A download asks for one by name; one the row does not
have is a 404 and never a signed URL pointing at nothing.

The asymmetry is the point. An image and a voice note are **replaced** by
something this install encoded, which is what strips EXIF and ICC and disarms a
polyglot. A video and a file keep the bytes that arrived, so their protection is
the size cap, the sniff, the scanner and the fact that they are only ever served
as a download.

Only what this install encoded is served `Content-Disposition: inline`. An
uploaded PNG is downloaded; its WebP is what a thread renders.

## Scanning

Optional, and off unless `CLAMAV_HOST` is set. It applies to the `file` kind:
images, voice notes and videos are re-encoded or size-capped and are not handed
to the scanner.

| `scan_status` | When |
|---|---|
| `skipped` | No scanner configured, or the kind is not `file`. |
| `clean` | clamd answered and found nothing. |
| `infected` | clamd found something. The object is deleted; the row stays, with `status = infected`, as the record. |
| `error` | clamd was configured and could not be reached or did not answer. The attachment is **rejected** with `scan_error`. |

A scanner that is configured and silent is a failure, never a pass: an install
that asked for scanning and quietly got none is worse than one that never asked.

The file is streamed to clamd over TCP, so the daemon needs no access to the
worker's filesystem and the two may be different containers.

## Rejections

`reject_reason` is a key, never a sentence and never a tool's stderr — that
would carry the worker's paths and the name of every binary on it.

| Reason | Meaning |
|---|---|
| `kind_disabled` | The brand has that kind switched off. |
| `mime_not_allowed` | The declared type is not on the brand's list, or the pipeline cannot verify it. |
| `too_large` | Bigger than the brand's cap for that kind. |
| `object_missing` | Confirm found no object, or the worker could not download one. |
| `mime_mismatch` | The magic bytes disagree with the type that was declared. |
| `unreadable` | The bytes are of the right family but would not decode. |
| `timeout` | A conversion ran past its budget and was killed. |
| `scan_error` | The scanner was configured and did not answer. |
| `infected` | The scanner found something. |
| `processing_failed` | Anything else the worker could not finish. |

A rejection at **presign** is a status code, because nothing has been stored:
`400` for a disabled kind, `413` for a file that is too big, `415` for a type
the brand does not accept. A rejection at **confirm** is answered as a row with
`status: "rejected"` rather than thrown: the request runs inside the tenant
transaction, so an exception would roll the rejection back and leave the row at
`pending` with nothing saying why.

## Endpoints

All four hang off the ticket, because an attachment has no life of its own.
`ticket:write` uploads and deletes; `ticket:read` downloads.

### `POST /api/brands/:brandId/tickets/:ticketId/attachments/presign`

```jsonc
// request
{ "kind": "image", "mime": "image/png", "size": 51234, "fileName": "shot.png" }

// 201
{
  "attachmentId": "0193…",
  "url": "https://s3.example.com/…?X-Amz-Signature=…",
  "headers": { "content-type": "image/png", "content-length": "51234" },
  "expiresAt": "2026-09-19T12:05:00.000Z"
}
```

`headers` must be sent verbatim: `content-type` and `content-length` are part of
the signature, so a client that adds, drops or rewrites one gets a 403 from the
bucket rather than an upload nobody checked the size of. A browser sets
`Content-Length` itself from the `File` it is sending and cannot be made to lie
about it, which is what makes the size cap real rather than advisory.

The URL lives five minutes and accepts exactly one object at one key.

### `POST …/attachments/:attachmentId/confirm`

No body. `HEAD`s the object, re-checks it against the policy with the size the
bucket reports, moves the row to `processing` and writes an
`attachment.uploaded` outbox row in the same transaction — so a confirm that
rolls back queues nothing
([DOMAIN-RULES §6](../planning/DOMAIN-RULES.md#6-transactional-outbox)).

Confirming twice is not an error and does not enqueue a second job. Answers the
attachment, whatever state it ended in.

### `GET …/attachments/:attachmentId?variant=webp`

```jsonc
{
  "attachment": { "id": "0193…", "status": "ready", "variants": { … } },
  "variant": "webp",
  "url": "https://s3.example.com/…?X-Amz-Signature=…",
  "expiresAt": "2026-09-19T12:05:00.000Z"
}
```

`variant` defaults to `original`. Answers `409` while the row is `pending` or
`processing` — which is what a client polls on — and `404` for a variant the row
does not have, including the `original` of an image whose brand does not keep
originals.

A **soft-deleted ticket** (M1-08) takes its attachments out of reach with it:
the rows survive the delete, so the read joins `tickets` and no URL is issued
for a ticket the desk has hidden.

### `DELETE …/attachments/:attachmentId`

`204`. Only a `pending` or `rejected` row: a `ready` attachment belongs to a
message and is deleted with its ticket by retention, and an `infected` row is
kept deliberately as the record that something was caught.

### Sending attachments with a message

`POST /api/brands/:brandId/tickets/:ticketId/messages` takes an optional
`attachmentIds`, and links them in the same transaction as the message.

```jsonc
{ "kind": "public", "bodyHtml": "<p>Here you go.</p>", "attachmentIds": ["0193…"] }
```

A reply to a closed ticket may land on a **continuation** of it
([DOMAIN-RULES §2.3](../planning/DOMAIN-RULES.md#23-reopen-policy), M1-08). The
uploads were made against the ticket the caller addressed and the message is
written to the continuation, so the attachments are moved across with it: an
attachment on a different ticket from its own message would be invisible to the
thread that renders it. A continuation is created in the same brand and
department, so the denormalised `department_id` the policy reads stays true.

Four rules, and each one refuses the whole send rather than dropping an
attachment quietly — a message that silently lost a file is a message somebody
believes they sent with it:

1. No more than the brand's `maxAttachmentsPerMessage`.
2. Uploaded against **this** ticket.
3. Uploaded by **this** principal. Two agents composing on one ticket cannot
   take each other's drafts.
4. Not `rejected` and not `infected`. An attachment that is still `processing`
   may be sent: it is the normal state a second after the upload is confirmed,
   and the thread shows a placeholder until `attachment.ready` arrives.

Every message in a thread read carries its `attachments`, resolved for the whole
page in one statement.

### Realtime

When the worker finishes, an `attachment.ready` outbox row becomes an
`attachment:changed` frame on the `ticket:<id>` room:

```jsonc
{ "brandId": "…", "ticketId": "…", "departmentId": "…", "attachmentId": "…", "status": "ready" }
```

Ids and a status, and no URL: a presigned URL is issued to a caller who was
authorised on the parent ticket at that moment, and one broadcast to a room
would outlive that check. The frame says "look again"; the look is a REST read
([DOMAIN-RULES §7](../planning/DOMAIN-RULES.md#7-realtime-delivery-contract)).

## Configuration

| Key | Required | Meaning |
|---|---|---|
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | yes | The bucket. It must be **private**. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | Credentials with read, write and delete on that bucket and nothing else. |
| `S3_FORCE_PATH_STYLE` | no (`false`) | `true` addresses the bucket as a path. MinIO, Ceph and most self-hosted gateways need it; Amazon S3 does not. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | no (`ffmpeg`, `ffprobe`) | Where the worker finds them. Bare names resolve on `PATH`. |
| `CLAMAV_HOST`, `CLAMAV_PORT` | no (unset, `3310`) | A clamd daemon. Unset means no scanning. |

### What the worker needs

**ffmpeg and ffprobe**, for voice notes and video posters. The Docker image
installs them, so a Compose deployment needs nothing. Without them, images and
files still work and audio and video are rejected with `processing_failed`.

The poster frame is taken as a **PNG** and turned into WebP by sharp, not by
ffmpeg: ffmpeg's WebP encoder is the optional `libwebp` build flag, and a poster
that depends on how somebody compiled ffmpeg is a poster that works on one
install and not the next.

**ClamAV**, optionally. The Compose stack ships a profile for it:

```bash
docker compose --profile clamav up -d
# then, in .env
CLAMAV_HOST=clamav
```

It wants about 2 GB of memory, which is why it is off by default.

### Development

The dev stack runs MinIO and creates the bucket with an `mc` sidecar:

```bash
cd docker
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  --profile dev up -d postgres redis minio minio-bucket
```

The console is at http://localhost:9001 with the `S3_*` credentials from `.env`.
MinIO has no "create on first write", so the sidecar is what makes the bucket
the api expects; it runs once and exits.

## Retention

Attachments follow their ticket
([DOMAIN-RULES §11](../planning/DOMAIN-RULES.md#11-data-lifecycle)).

**What exists today** is the database half: `attachments.ticket_id` cascades, so
deleting a ticket deletes its attachment rows, and `brand_id` cascades the same
way for a brand. The key layout is what makes the object half one list and one
delete loop — `brands/<brandId>/tickets/<ticketId>/…`, so a brand's objects and
a ticket's objects are each a single prefix.

**What does not exist yet** is the pass that runs either of them. `maintenance.retention`
is defined in `@helpdock/jobs` and purges the outbox and receipts only; nothing
deletes S3 objects on a schedule, and nothing sweeps the `pending` rows left by
a composer that uploaded and never sent. Both land with the retention
deliverable, M1-14. Until then an install's bucket keeps the objects of deleted
tickets, which an operator can remove by prefix by hand.

## Limits and budgets

| Thing | Value | Why |
|---|---|---|
| Presigned URL lifetime | 5 min | DOMAIN-RULES §4.5. |
| Image decode ceiling | 64 megapixels | A 100 KB PNG can declare 40 000 × 40 000 and cost six gigabytes to decode. |
| sharp budget | 30 s per call | libvips runs outside the event loop, so an image built to be slow would otherwise occupy a worker with nothing to stop it. |
| ffmpeg audio budget | 60 s | A crafted file that makes a decoder loop must not stop the queue. |
| ffmpeg poster budget | 30 s | The same. |
| ffprobe budget | 15 s | The same. |
| ClamAV budget | 120 s | Streaming a file of up to the `file` cap. |
| `media.process` attempts | 3, exponential from 5 s | The failures worth retrying are a bucket that blinked, not bytes that will decode differently next time. |

ffmpeg is given `-protocol_whitelist file`, so a crafted container cannot make
the worker fetch a URL — the same rule DOMAIN-RULES §13 applies to the HTTP
client, enforced where the decoder is rather than where the request is.

A verdict about the bytes — a mismatch, an image that will not decode, a file
the scanner caught — marks the row and **returns**. Retrying a decision that
cannot come out differently would only delay telling the person waiting.

## Client helper

`apps/admin/src/media/upload.ts` does presign → PUT → confirm, with upload
progress; `use-attachment.ts` watches a row until the pipeline is finished with
it. The contract is in
[`apps/admin/README.md`](../../apps/admin/README.md#attachments-m1-10).

## What later milestones add

| Milestone | What |
|---|---|
| M1-14 | The nightly purge of abandoned `pending` uploads and their objects. |
| M1-15 | The composer and the thread: a file picker constrained by the policy, a progress bar, a placeholder that swaps on `attachment:changed`. |
| M4 | The widget's uploads and `MediaRecorder` voice notes, against the same endpoints under a visitor principal. |
| M6 | Telegram media: `getFile` fetches the bytes and hands them to this pipeline as a `system` uploader. |
| M7 | Optional transcription of a voice note (`ai.transcribe`), stored on the message. |
