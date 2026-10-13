# Helpdock import engine boundaries

This workspace holds the M11 connector contract, bounded vendor HTTP transport,
rate limiting and streaming file readers. The connectors and API jobs are still
being implemented; this foundation alone does not import a brand.

`Connector` yields `{ records, cursor }` pages. Every record is a shared
`{ entity, payload }` discriminated union; `payload.externalId` retains the vendor's
identifier. The API must stage a page and its next cursor atomically. A final null
cursor ends that entity's extraction. A page contains only the entity requested;
external IDs within that page are unique, and a non-final cursor must advance.
Pages may overlap records across requests; staging upserts those records without
counting them twice. The API page store bounds a page to 1,000 records and 50 MiB
serialized and commits records/counts/cursor together. Vendor credentials belong only in the encrypted API run,
never in normalized records or emitted cursor data. Connector log messages are
approved warning codes (`import.record-unavailable`, `import.attachment.expired`,
`import.mapping.unknown-value`), not vendor response text. The API scopes the log
to the run and validates each entry before storage.

`ImportHttp` validates JSON output and uses `safeFetch` with exact vendor host
allow-lists, including redirects. Callers supply the operator's network policy.
Responses are bounded by that policy, with a hard 50 MiB ceiling and a 30-second
total deadline. Authorization headers are stripped on cross-origin redirects by
the underlying client. A 429 throws `RateLimited` with a delay from `Retry-After`;
the worker must persist that delay rather than spending an attempt. Provider error
bodies never become `ConnectorError` messages. Invalid UTF-8 is rejected as an
invalid response rather than replaced with different characters.

`hashImportValue` validates JSON and hashes a canonical representation. Nested
object key order does not change identity; array order does. Non-JSON values are
refused instead of being silently dropped. The loader excludes expiring download
URLs from message hashes and keeps body/attachment identity changes meaningful.

## Import bundle version 1

A ZIP contains `manifest.json`, singular entity files such as `ticket.ndjson` and
`message.ndjson`, and optional members under `attachments/`. Each NDJSON line is
the entity's payload, without an extra `{ entity, payload }` envelope. The manifest
has `format: "helpdock-import"`, `version: 1`, a supported source, an ISO export
time and per-entity counts. Record times require an explicit timezone offset.

```ts
import { readImportBundle } from '@helpdock/importers';

for await (const event of readImportBundle({ path: '/tmp/export.zip' })) {
  if (event.type === 'manifest') {
    console.log(event.manifest.counts);
  } else {
    // Stage this validated record; do not invoke live ticket creation paths.
    console.log(event.record.entity, event.record.payload.externalId);
  }
}
```

The reader never extracts members to filesystem paths. It rejects encrypted
members, links, traversal, duplicate member names, missing attachment references,
unknown entity files and count mismatches. Standard empty attachment directory
entries are allowed. Files are bounded to 2 GiB compressed and 2 GiB expanded,
100,000 members, a 64 KiB manifest and 4 MiB per NDJSON line. Custom JSON is bounded
to 100 nesting levels before recursive validation. These are resource limits,
not a promise that all records have been loaded: a late count failure invalidates
the run, and staged records must not be loaded until extraction succeeds.

Malformed JSON and records report their file and physical line via
`ImportFileError`; raw field values are excluded from the error message.
Malformed UTF-8 reports `invalid-encoding` with the file name; decoding errors do
not claim a physical line because a chunk can span multiple lines. Valid UTF-8
characters split across chunks remain intact. Breaking iteration closes the
current stream and archive. An optional abort signal stops iteration at the next
chunk or member.

Unit tests use local HTTP servers and small ZIP fixtures. Database/RLS and job
integration tests live in the API/DB workspaces and use real infrastructure.
Vendor stand-ins must follow each vendor's current official documentation.
