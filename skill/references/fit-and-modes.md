# Fit assessment & run modes

UB's burn-down loop is one shape of work, not the only one. Real projects are **mixed portfolios**: an existing durable spine (HANDOFF/ROADMAP/issues), a wall of gates (wall-clock, operator/legal, external-ETA, decisions), fragile hot-path lanes where green tests are not "done," and a safe/small lane the loop nails. Before running the loop relentlessly, spend one cheap pass deciding **whether** to run it, and in which mode. A tool that declares where it does and doesn't fit — and runs bounded — is more trustworthy than one that always says yes.

Run this at `start` (after Setup + portfolio gate-routing, before the loop). Skip on `continue` (resume from `pausedInfo` first) and never as a guest. Re-run it when the portfolio shape changes materially.

## The fit-check (computed from fields UB already has)

No new taxonomy and no dependency on the gate-routing sweep — read the queue you just routed and tally a few signals from existing fields. `ub list` (now emits `tags`, `risk`, `engine`, `status`, `deps`) + `ub status` give you everything:

- **Fragile fraction** — proportion of open, non-gated items with `risk=high` **or** `engine ∈ {rigorous, rigorous-lite}`. This is the *buildable stakes*: on a mature project the buildable remainder is often exactly the fragile hot-path work that needs fresh context + adversarial verification — the opposite of rapid burn-down.
- **Gate load** — count items sitting behind a gate: `awaiting_operator` (operator/legal), a stated side-effect boundary, or an unsatisfied `dependsOn`.
- **Dated-wait load** — count items with a dated `deferUntil` (wall-clock) or `blockedRetryAt` (external-ETA) — these auto-return via the reconciler; they are parked, not stalled.
- **Safe lane** — the remainder: `ready`, `risk≤low`, independent, cheaply-verifiable. This is the class the loop is built for.
- **Spine** — did Setup's tracker-detection (Setup step 6) find an authoritative external backlog? A strong spine means UB drives a *slice*, it is not the source of truth.

You are not scoring a formula; you are reading which of the four buckets dominates the *buildable* remainder, then picking the matching mode below.

## The run-mode matrix (3 postures, 4 rows — BOARD-ONLY and SKIP share one posture)

| Condition | Mode | What UB does |
|---|---|---|
| Weak/no spine **and** safe lane dominant (fragile + gated small) | **FULL AUTONOMOUS** | UB-canonical; relentless burn-down + parallel waves on the safe lane; `/rigorous` for the few high-risk items. |
| Meaningful safe lane **but** fragile/gated also significant | **BOUNDED (safe-lane)** | Run only `risk≤low` / a named lane to *lane-scoped* quiescence, tee fragile lanes up as serialized `/rigorous` tasks, stop cleanly at the gate wall. The "keep working overnight" ask. |
| Strong spine **and** portfolio mostly gated/fragile (thin safe lane) | **BOARD-ONLY** | Mirror the external spine into the UI (read-mostly), mark UB non-authoritative, `ub idle --reason`, run **no** loop. |
| Almost all gated/fragile, strong spine, no board wanted | **SKIP** | Keep the handoff doc + chips as the spine; drive fragile lanes as focused `/rigorous` runs. Revisit for an overnight stretch. |

**BOARD-ONLY and SKIP are the same posture** — "don't run the loop, keep capture live" — differing only in whether a mirrored UI board is wanted. Realize both the same way:

```
ub register                     # own the loop so idle is allowed
# tell the Operator the UI URL (board-only) or skip that line (skip)
ub idle --reason "board-only: operator drives; UB captures + mirrors, no autonomous loop"
```

`ub idle` with that reason disarms the stop-guard (`SKILL.md` Quiescence) so ending the turn is a clean exit — the loop is off, but **capture stays on**: newly-discovered work is still `ub add`ed durably, and the board still reflects the spine. This is a first-class outcome, not a failure to run.

## Coexistence overlay (whenever Setup found a spine)

Pick one and state it in the first task's context; never run two live backlogs:

- **(a) mirror-import** (default for strong spines) — the external tracker stays canonical, UB holds thin pointers (see `linkedSource` / `--kind --ref` in the capture rule), completion is surfaced for the Operator to reflect back. UB never overwrites the external doc.
- **(b) UB-canonical + export** — greenfield/weak spine, with Operator consent: UB is the source, snapshot to `.planning/unfinished-business/`.

**Invariant: exactly one canonical source per item.**

## Bounded safe-lane run (the mechanism behind BOUNDED)

To run only the safe class — e.g. overnight — use the session risk ceiling:

1. First ensure fragile classes are actually tagged: `ub update <id> --set-risk medium` / `high` on the known-hot-path work. **The ceiling is only as good as the tagging** — newly-captured tasks default to `low`, so pre-tag known-fragile areas before you rely on it.
2. Register with the ceiling: `ub register --max-risk low` (or `ub next --max-risk low` on the first call). `pickNext` then serves only tasks at/below the ceiling; everything above it is left untouched.
3. The loop drains the safe subset to **bounded-idle** and reports *"left N medium/high for focused /rigorous runs"* — explicitly **NOT** true quiescence (the idle audit records `bounded:true, maxRisk, deferredByCeiling:[…]` so the board distinguishes the two).
4. Truly irreversible / outward-facing work is already held by the side-effect boundary regardless of risk — the ceiling is an *additional* safety lane, not the only one.
5. Re-register without `--max-risk` to resume the full portfolio.

Cheaper one-off fallback (no ceiling): dated `ub later --until <ISO>` on the fragile subset so `ub next` simply can't surface them tonight.

## Guardrails

- **A mostly-gated portfolio is a success state** (gated-rest), not a stalled loop. BOUNDED / BOARD-ONLY / SKIP are first-class sanctioned outcomes.
- **Anti-abdication.** If any `ready`, low/med-risk, independent task exists, FULL or BOUNDED applies and its safe lane runs **to quiescence before any gate wall is declared**. You do not get to call "board-only / all gated" while executable work sits `ready`. Board-only/skip are for genuinely thin safe lanes, not for skipping work you'd rather not do.
- **Re-run the fit check** when the portfolio shape changes (a gate clears and a fragile lane becomes buildable; a wave of safe work lands).
