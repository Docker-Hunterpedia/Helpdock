# 0030 AI decisions in automation are confidence-gated and one-directional

Status: proposed
Date: 2026-10-20

## Context

M7-07 shipped AI triage as a rule action, `ai_triage` with mode `suggest`
(stored in `ticket_field_suggestions`, accepted or dismissed in the SuggestedFields
card) or `apply`. Teams want it to apply what it is sure of and leave the rest
for a person, and they want rules that branch on a question only a model can
answer ("Is the customer asking to cancel?"). Both put a model's judgement into
automation, where a wrong answer acts without anyone looking, and where cost
scales with ticket volume.

M12-10 and M12-11 ([plan](../in-development/M12-ai-workspace.md)) add both,
still inside the 1.0 rule: the model returns a decision, and Helpdock's code
applies it under a rule an admin wrote.

## Decision

1. **Confidence per field.** The triage classifier returns a confidence 0–1 for
   each field it decides, the model's own estimate. A new mode `auto` applies a
   field at or above a threshold (0.5–0.99, default 0.7) and stores it as a
   suggestion below. M7-07's `suggest` and `apply` modes stay.
2. **One direction only, whatever the mode.** Priority only rises; tags are
   only added; a department moves only while no staff member has changed it on
   this ticket (`tickets.department_changed_by_staff_at` is null); spam is never
   applied. Every applied change is an activity row with `via: ai`, actor "the
   assistant", the rule if any, and the confidence; it can be undone like any
   change. Setting a field by hand clears its suggestion.
3. **AI questions in rules.** A condition `ai_question { question, op: above |
   below, threshold }`, at most 3 per rule, event rules only. Evaluation is two
   phases: other conditions first; questions are collected only from rules
   still matching, and all of one event's questions go in one `complete()` call
   outside any transaction (redacted, logged, budgeted). Answers are cached per
   ticket, question hash and latest message seq. A refused or failed call makes
   the condition false and is recorded in the run log, never retried within the
   run. The depth guard and cycle detection of M3-03 are unchanged.
4. **Calibration is measured, not assumed.** The eval adds triage precision at
   the default threshold (≥ 90 %) and AI-question accuracy (≥ 90 %) per
   language (DOMAIN-RULES §9 additions).

## Consequences

- A wrong `auto` decision can only raise a priority, add a tag or move a
  department nobody has touched, and is visible and reversible in the timeline.
- Cost stays bounded: questions only after other conditions hold, one call per
  event, a cache per message seq, no time-based rules, estimates shown in the
  rule builder, and the budget hard stop applies.
- AI questions in time-based rules are a gap, not a promise: cost would scale
  with every matching ticket on every tick.

## Alternatives considered

- **A third-party calibrated decision model**: a new required dependency and
  a new data processor for every install.
- **Apply without confidence**: M7-07's `apply` stays for teams that want it,
  but it is not the default for new automation.
