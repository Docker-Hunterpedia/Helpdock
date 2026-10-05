# M7 AI

Status: in progress
Started: 2026-10-05
Owner: @Docker-Hunterpedia

## Scope

Full deliverable list and specs: [PRD §4 · M7 AI](../planning/PRD.md#m7-ai).
Depends on M3, M4, M5 (shipped) and M6 (in progress in parallel; M7-06 Telegram auto-reply lands after M6).

## Deliverables

| Id | Deliverable | Issue | Status |
|---|---|---|---|
| M7-01 | Provider layer on pi-ai | | planned |
| M7-02 | Embeddings per D §8 | | planned |
| M7-03 | Ingest | | planned |
| M7-04 | Hybrid retrieval with `audience` | | planned |
| M7-05 | Agent assist | | planned |
| M7-06 | Auto-reply on widget, Telegram and email with confidence threshold, transparent handoff, " | | planned |
| M7-07 | Auto-triage as a workflow action | | planned |
| M7-08 | Guardrails | | planned |
| M7-09 | Voice transcription job (Whisper-compatible endpoint) shown to agents | | planned |
| M7-10 | Admin | | planned |
| M7-11 | Evaluation harness | | planned |

## Exit criteria

Copied from the PRD, ticked as they are met.

- [ ] Auto-reply answers a question from an uploaded PDF with a citation, and hands off when confidence is below threshold, in an E2E test with a mocked provider.
- [ ] The evaluation run meets every threshold in DOMAIN-RULES §9 for both English and Arabic.
- [ ] After a handoff, no auto-reply is sent for the rest of the conversation even if a queued job fires late.
- [ ] A visitor-audience query never retrieves an internal chunk (SQL-level test), and a fabricated citation is dropped.
- [ ] Budget hard stop disables auto-reply and is visible in admin.
- [ ] PII redaction is covered by unit tests for emails, phones, cards (Luhn), IBANs.

## Open questions

- None yet.

## Pull requests

- None yet.
