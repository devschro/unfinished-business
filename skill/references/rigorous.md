# Rigorous Mode cooperation protocol

/rigorous and /rigorous-lite are one-shot quality protocols. They reject "deferred work" by doctrine, so Unfinished Business cooperates by **harvesting artifacts after each run** — never by asking a run to emit a deferred-items list, and never by patching the skills.

## Invoking

- Always pass the task explicitly via the Skill tool: `Skill(skill: "rigorous", args: "<self-contained task statement + relevant context + pointer to UB task id>")`. Never rely on no-args conversation binding.
- **Rigorous runs *inline* in the current session** (via the Skill tool) — it does **not** hand the main thread a fresh context. Its councils run in separate sessions, but the orchestration is inline. When a fragile / hot-path task needs clean context (heavy session, high blast radius), get that from a UB **pause/resume** boundary *first* — the only UB mechanism that yields a fresh execution context — then invoke rigorous from the fresh resumed session. Don't conflate rigorous's separate-session councils with a fresh main context.
- Small quality-critical → `rigorous-lite` (it may auto-promote itself to full rigorous; that is normal — follow it).
- One rigorous run per repository at a time (its witness file `.planning/rigorous/INTENT.md` is a fixed path; concurrent runs clobber each other).
- Re-queuing a swept residual: **reframe it as a fresh standalone task with its own goal sentence.** Never phrase it as "fix what the last run found" — execution-iteration is forbidden by the skill and behaves unpredictably. If you genuinely need re-execution of an already-verified goal, pass `--full` (otherwise the re-entry short-circuit silently degrades to verify-only).

## Completion signal

Parse the **last** `LOOP_STATUS {json}` line of the run. Accept the full union (the skills' own enums are incomplete):

| status | action |
|---|---|
| `converged` | harvest residuals, verify, `ub done` |
| `promoted` | lite promoted to full rigorous — keep the UB task open, follow the full run |
| `blocked` | side-effect-class pause or escalation → `ub block --operator` with the ⏸ pause reason |
| `non-converged` / `plan-failure-recovery-pending` | enqueue the `resume` path as a **new** UB task; block the original with the details |

## Post-run residual harvest (mandatory, in this order)

1. `.planning/rigorous/INTENT.md` — read sections `# Out of scope (rejected upfront)`, `# Decisions log` (accept-in-writing entries), `# Phase 4 Attack Vectors` (accepted risks), `# Plan-Failure Cap-Exhausted` (if present). Every item worth doing → `ub add` with `--context "rigorous run for <task-id>: <section>"`. Items genuinely not worth doing → note why in the UB task's evidence.
2. **Archive the witness**: copy `INTENT.md` to `.planning/rigorous/history/<goal-slug>-<timestamp>.md` (create dir) so the next queue item cannot clobber this run's record. Copy, don't move — moving disables rigorous's cheap verify-only re-entry.
3. Transcript `🔎 FINDING` blocks whose Action is not "fixed" → capture each.
4. Lite runs additionally: any "continuation queue" text in the handoff, "queue tests for survivors" mutation-probe lines, and every `spawn_task` chip it emitted → capture each as a UB task (the chip's title/prompt are self-contained).
5. A non-null `resume` path in LOOP_STATUS → first-class UB task.

## Concurrency budget

Rigorous mandates internal parallelism ("do not throttle") — up to ~7 simultaneous agents per plan iteration, more with councils. UB's contribution is the outer budget: run **one** rigorous task at a time, never in a parallel wave, and don't start other heavy engines while it runs. Its internal councils (N=5/7) satisfy the Operator's council requirement for quality-critical work; UB's own prep councils cover planning-time decisions.
