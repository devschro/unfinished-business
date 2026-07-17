# Pause / context reset / resume — exact procedure

The goal: the Operator presses **Pause safely** (or you pause proactively for context health), the session checkpoints losslessly, the Operator runs `/clear`, and a fresh session continues exactly where this one left off — while the UI stays live throughout (the server is a separate OS process).

## When you receive `directive: pause` from `ub next`

1. **Drain to a safe point** — finish only the current atomic step: the edit you're mid-way through plus its check, or the current subtask. Do not start anything new. If mid-engine-run (gsd-quick/execute-phase), let the current plan/task commit land; these engines resume cleanly later.
2. **Update the task record**: `ub update <id> --set-status ready` if you hadn't really started, or leave `in_progress` and mark completed subtasks — the record must reflect reality.
3. **Checkpoint:**
   - **GSD project** (`.planning/` exists): run `/gsd-pause-work`. While it writes the handoff, ensure `HANDOFF.json`'s `next_action` says: `Run /unfinished-business continue to re-enter the work queue (task <id>)` and `context_notes` carries your exact mental state (what you were doing, what's next, gotchas). The handoff is one-shot — resume deletes it — so anything that must survive longer goes in the UB task record via `ub update`.
   - **Non-GSD project**: no GSD artifacts needed; the UB server holds everything. Put your full position into the note in the next step.
4. **Confirm to the server:**
   ```bash
   ub paused --method gsd-pause-work --task <id> --note "<one paragraph: exact position, next action, gotchas>"
   # or --method ub for non-GSD projects
   ```
5. **Tell the Operator** (the UI shows the same): run `/clear`, then `/gsd-resume-work` and type `continue` when it loads (GSD), or `/unfinished-business continue` (non-GSD). Then **end your turn**. Do not keep working after confirming a pause.

## Proactive pause (context health)

Same procedure, without the directive: after a large task completes, or when the session is degrading, pause on your own initiative. Say why in the note. A lossless pause beats a sloppy finish.

## Resume (fresh session)

`/unfinished-business continue` (or arriving via `/gsd-resume-work`, whose handoff points here):

1. `ub ensure` then `ub register` → returns `resumed: true` with `pausedInfo` (method, currentTaskId, note).
2. Read the note. If method was `gsd-pause-work` and `.planning/HANDOFF.json` still exists, `/gsd-resume-work` owns code-level restoration — let it run first if the Operator hasn't already.
3. `ub show <currentTaskId>` — reconcile: which subtasks are done, what the plan says is next.
4. Re-enter the loop at exactly that point. Do not re-do completed work; trust the evidence trail.

## Failure cases

- Pause requested but no safe point is nearby (e.g. a rigorous run mid-execution-wave): keep draining to the nearest boundary — never abandon a half-applied edit. There is no progress-note verb, so don't touch the task record mid-drain; when you reach the boundary, run `ub paused` with a note that explains the delay and the exact state. (`ub note` is for the Operator's messages to you — never use it for your own.)
- `ub paused` fails (server down): write `.unfinished-business-HANDOFF.md` at the project root with the same note, tell the Operator, end turn. On resume, `ub register` + that file restore state; delete the file after use.
- **No API response is ever the only copy of anything.** The pause checkpoint is written to durable `pausedHistory` (last 5) at register time, so even if the `ub register` response is lost you can recover it with `ub handoff` — it reprints the latest checkpoint any time. Likewise, an operator note is only *acknowledged* on your next `ub` call after it's delivered; if your session dies mid-delivery, the next session gets it again marked `redelivered: true` (act idempotently — check whether it was already handled).
- Resume finds `pausedInfo: null` (e.g. server restarted): reconstruct from the queue itself — `ub list`, find `in_progress` tasks, read their activity/subtasks, continue conservatively.
- A task left `in_progress` by a session that vanished carries a **lease**. If the session stays gone past the lease TTL (~135 min), the server auto-reclaims it to `ready` and redelivers it (a `reclaimed` activity entry records this). On resume you may therefore find your former in_progress task back in `ready` with its subtasks/evidence intact — that is expected; reconcile and continue, don't redo completed subtasks. Registering with a `pausedInfo.currentTaskId` re-stamps that task's lease to the new session, so a prompt resume keeps its claim.
