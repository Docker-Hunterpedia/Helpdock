# 0009 Sniff upload MIME types with a table in-house, not with `file-type`

Status: accepted
Date: 2026-09-19

## Context

[ARCHITECTURE §9](../planning/ARCHITECTURE.md#9-media-pipeline) says the media worker must "sniff MIME (magic bytes), reject mismatch", and [REQUIREMENTS §5.1](../planning/REQUIREMENTS.md#51-security-non-negotiable) says "MIME sniffing (not trusting extension)". Neither names a tool, and no sniffer is in the stack table, so using one is a dependency that needs this ADR.

The obvious candidate is `sindresorhus/file-type` (22.x): well maintained, recognises several hundred formats, ESM, and would be about a hundred lines of our own code replaced by an import.

Three things make it a worse fit than it first looks.

- **The set of types is closed and small.** A brand may only allow what the pipeline can encode or verify, so the whole allow-list is four image formats, two video, three audio and five file types (`packages/schemas/src/media.ts`). A table for exactly those is about a hundred lines that fit on one screen — which matters, because this is the check that decides whether a file a stranger uploaded is what it claims.
- **It would not answer the two hard cases anyway.** `text/plain` has no signature at all, and `.docx`, `.xlsx` and `.zip` are the same four bytes (`PK\x03\x04`); `file-type` returns `undefined` for the first and reads the Zip central directory for the others. Either way this codebase still has to decide what "a text file" is and whether the three Zip-based types need telling apart. It does not: all three are served as `Content-Disposition: attachment`, none is ever rendered, and the scanner sees the same bytes.
- **Sniffing is not the defence it looks like.** A PNG/JavaScript polyglot *is* a valid PNG, so every sniffer on earth accepts it. What disarms it is sharp re-encoding the image to WebP and dropping everything that is not pixels (REQUIREMENTS §5.1: "image re-encode via sharp (kills polyglots + strips EXIF)"). The sniff's job is narrower: refuse a file whose bytes disagree with the type it was presigned under, so that a `.pdf` cannot arrive claiming to be a `.png` and be re-encoded, or an executable arrive claiming to be a PDF and be handed back as one.

## Decision

Sniff in `apps/api/src/media/magic-bytes.ts`, with no dependency.

1. A table of signatures for the ten byte families the allow-list can produce: PNG, JPEG, GIF, WebP (RIFF form checked at offset 8), WebM/Matroska (EBML), ISO base media (`ftyp` at offset 4, which covers both `video/mp4` and Safari's `audio/mp4`), Ogg, PDF, Zip and text.
2. A map from each allowed MIME type to the families it may legitimately be. A declared type that is not on the map is **refused**, never waved through, and `checkUpload` refuses a brand policy that names a type the map has no entry for — so a brand cannot allow something the worker would have to guess about.
3. `text/plain` is "valid UTF-8, no NUL, no C0 control characters other than tab, newline and carriage return", with up to three trailing bytes dropped because the probe reads a fixed 64 bytes and the last character is usually cut in half.
4. The three Zip-based types share one family. Distinguishing them is not attempted.

## Consequences

- No new dependency on the path that decides whether an uploaded file is what it says, and nothing to audit on an upgrade.
- The table is the one place to look when asking "what can be uploaded here", and it is short enough to read. A format a later milestone allows — Telegram's `.oga` in M6, say — is a row here and a row in the policy, and the unit suite fails until both exist.
- A type with no signature cannot be allowed, which rules out `image/svg+xml` and `text/html` by construction. That is the intended outcome: both are documents that execute, and neither has a path through this pipeline.
- A `.docx` uploaded as `application/zip`, or the reverse, is accepted. Both are downloads, both are scanned, and neither is rendered, so nothing follows from the confusion.
- If a later milestone needs to accept many formats — a knowledge-base ingest that takes whatever an operator has, for instance — this decision should be revisited rather than stretched, and `file-type` on the server alone (never in the widget bundle) is the likely successor.

## Alternatives considered

- **`file-type` 22.x.** Rejected for the reasons above: the surface it covers is far wider than the allow-list can ever be, it does not remove the two decisions that actually need making, and it puts a dependency on the step that decides what bytes this install is willing to store.
- **Trust the `Content-Type` the client declared.** Rejected outright: REQUIREMENTS §5.1 exists because a client's declaration is exactly what an attacker controls.
- **Trust the extension.** The same objection, with the added problem that the object key never contains the filename at all.
- **Sniff with `sharp`/`ffmpeg` alone — "if it decodes, it is what it says".** Rejected: it says nothing about files that are never decoded (PDF, Zip, text), and it would mean handing every uploaded byte to a decoder before anything had checked what it was supposed to be.
