---
name: unfinished-business
description: Durable shared work queue between the Operator and Claude, with a live localhost UI, separate-session task preparation, and non-stop autonomous execution until genuinely nothing is left. Use when the operator invokes /unfinished-business, says "unfinished business", asks Claude to work through the queue / work non-stop / keep going until everything is done, wants follow-up work durably captured, or manages tasks through the Unfinished Business UI. Also invoke "unfinished-business add" behavior whenever work is discovered that cannot be done right now — every discovered task gets captured before it can be forgotten.
argument-hint: "[start | continue | add <text> | sync | status | stop]"
---

# Unfinished Business

A durable to-do queue shared between the **Operator** and **Claude**, backed by a local server that survives `/clear`, with a UI the Operator watches and edits. Your job while this skill is active: **capture everything, classify and route, prepare intelligently, execute every executable task relentlessly, verify honestly, route fragile work to focused rigorous runs, surface gated work honestly, and stop at true quiescence — which for a gated portfolio means everything executable is done and the remainder is transparently parked on the Operator.**

All commands go through the CLI (run from the project directory so the right project registers):

```bash
node "$HOME/.claude/unfinished-business/ub.mjs" <verb> ...
```

Call it `ub` below. Run `ub help` for full verb syntax.

## Invocation modes

| Args | What to do |
|---|---|
| *(none)* or `start` | Setup (incl. tracker detection) → import/sync work → gate-route → assess fit & choose mode → enter the loop |
| `continue` | Post-`/clear` re-entry: setup → apply `pausedInfo` from `ub register` → re-enter the loop (skip tracker-detect / gate-route / fit-assess — resume from where you paused) |
| `add <text>` | Capture one task (with `--context`), report id, return to whatever you were doing |
| `sync` | If an external canonical tracker exists, reconcile against it and import only the driven slice as thin pointers; otherwise sweep the conversation + project for uncaptured work and capture it all. Report |
| `status` | `ub status` + a short plain-English summary of queue, jobs, blockers |
| `stop` | `ub idle --reason "stopped by operator"`, summarize what remains |

## Setup

1. Every invocation: `ub ensure` (Bash tool) — starts the server if needed, registers the project, returns the UI URL. **Tell the Operator the URL once.**
2. **Only for `start` / `continue`** (the loop-owning modes): `ub register` — it defaults to this session's real `CLAUDE_CODE_SESSION_ID` (the stop guard and GSD gate hooks match on it). If it returns `resumed: true`, read `pausedInfo` (method, currentTaskId, note) and continue exactly there. If it returns `registered: false`, **another session owns the loop** — act as a guest: capture/answer only, never run the loop, pause, or `ub idle`. `add`/`sync`/`status` invocations never register (they must not steal the loop from a working session). The server now **enforces** this: loop-driving verbs (`ub next`, `ub idle`, `ub paused`, claiming/completing a task) return **403 `{role:'guest'}`** to a non-owning session — capture (`ub add`), reads (`ub list`/`ub status`), and all operator actions stay open. A 403 here means you are a guest; do not retry, just capture and stop.
3. If `ub ensure` reports `claudeCli: false` or `headlessAuth: "required"`, separate planning sessions can't run yet — prepare tasks yourself instead (the prep step of *Executing a task*; for proactive prep of queued tasks, plan via a read-only subagent then `ub update <id> --set-plan -`) and mention the one-time fix once: `node "$HOME/.claude/unfinished-business/ub.mjs" login`.
4. If `ub register` returned `inProgress` tasks and you did not just resume them, a previous session died without pausing: `ub show` each, reconcile against reality (which subtasks/evidence exist), then continue or reset them to `ready`.
5. Once per machine, if `ub hooks status` shows entries missing, suggest `ub hooks install` to the Operator (enables the non-stop guard, resume injection after `/clear`, GSD collision gate, and automatic capture signals — takes effect in new sessions). If this project has a `.mcp.json` with the UB bridge, prefer the native `ub_*` MCP tools over Bash CLI calls — same contract.
6. **Before bulk-importing** (`start` / `sync` only, before any bulk `ub add`): **detect an existing tracker.** Scan for an authoritative external backlog — `.planning/{ROADMAP,STATE}.md`, `*HANDOFF*.{json,md}`, `*REMAINDER*.md`, `EXECUTION-LOG*`, `.continue-here.md`, dense TODO/FIXME clusters, GitHub/Jira/Linear config (a heuristic, not a fixed list). If a **strong** tracker exists, do **not** fork a second backlog:
   - Record the declared canonical source in the first imported task's context (e.g. "canonical backlog: `.planning/ROADMAP.md` — UB mirrors a driven slice only").
   - Import **only the slice UB will actively drive now**, each as a **thin pointer, not a copied body**: run a read-only subagent that parses the source and emits classified pointer tasks, each `ub add "<name>" --context "see <path/§ or issue-id>" --kind <sys> --ref <stable-id>` — the `--kind/--ref` (S13) make re-import across sessions **dedupe-return instead of duplicating**.
   - **Invariant: exactly one canonical source per item.** UB drives a slice; it does not own these pointers. Never overwrite the external doc; surface divergence as a note for the Operator.
   - On completion, do **not** auto-write the external file (it collides with GSD's single-writer STATE/ROADMAP) — put the change in `ub done` evidence and surface it for the Operator to reflect back (writing back is outward-facing → side-effect boundary).
   - Greenfield / weak / no tracker → current behavior unchanged (UB may be canonical; optional export to `.planning/unfinished-business/`).

   This changes **only** how a pre-existing external backlog is bulk-imported. The capture rule below is unchanged and absolute — every newly-*discovered* task during execution is still captured immediately, with full body. See `references/fit-and-modes.md` for the coexistence overlay.

## The capture rule (always active, non-negotiable)

**Capture before judgment.** The moment you identify any unfinished-work candidate — a TODO, bug, missing test, inefficiency, doc gap, edge case, discussion commitment, out-of-scope discovery, reviewer/verifier finding you are not fixing right now, or a task the Operator mentions in conversation — capture it immediately. (When hooks are installed there is a mechanical backstop — unfinished native TODO items are captured as candidates at session end — but that is a safety net for what discipline missed, **not** a substitute for capturing deliberately as you go.)

```bash
ub add "Plain-English name" --instructions "what and how" --context "where this came from" [--size ...] [--risk ...] [--prep off|quick|full]
```

- Operator-dictated tasks: add `--from-operator` (provenance shows Operator).
- Small/uncertain/possibly-duplicate items still get captured — triage later by editing or asking; **never silently drop a candidate.** The Operator archives; you never do.
- `--risk` defaults to `low`; leave it unless *obviously* high — prep/triage classifies it. Do **not** inject a reversibility judgment into capture (that would slow the one-command capture path).
- **Serialize fragile chains at capture time.** When a later step is only safe once an earlier step is *verified*, set `--deps <id>` on each downstream task — the server won't surface a task with unsatisfied `dependsOn`, so the chain becomes a single-writer serial track `ub next` hands you one at a time. Give each fragile / hot-path task `--engine rigorous`.
- Capturing takes one command. Do it mid-task without losing your place, then continue.
- Capture is **durable even if the server is down**: `ub add` (and the MCP `ub_add_task`) fall back to an offline outbox that syncs automatically, and every add carries an idempotency key — so a timed-out or ambiguous `ub add` is **always safe to retry**; the server dedupes. If you see `captured: "offline"`, the task is saved and will appear once the server is reachable.

## Portfolio gate-routing (start + first ingest only)

Runs **only** in `start` and when `sync` brings new items; `continue` skips it (resume from `pausedInfo` first), and guest / `add` / `status` never run it. This is a lightweight **gate-routing sweep, not a full taxonomy** — for each open item with no routing decision yet (skip anything already `deferred` / `blocked` / engine-set — idempotent), ask only *"is this gated, and how?"* and set ONE field. **Default stays `ready`** — pull an item out of the burn-down lane only when a gate is visible:

- **wall-clock** (done-condition is a date/elapsed time) → `ub later <id> --until <ISO>`
- **operator / legal / approval** (human-only permission, deploy, account op) → `ub block <id> --operator --reason "<exact proposed action>"`
- **external-ETA / transient** (quota, rate-limit, external party finishing) → `ub block <id> --retry-after <min|ISO> --reason "<why>"` (`--reason` is required on every block)
- **fragile / hot-path** (shared or correctness-critical file, prior-incident) → `ub update <id> --set-engine rigorous --set-risk high` (add `--deps` only if there are real ordering dependencies)
- **decision-required** (output IS a choice) → `awaiting_operator`, **or** leave `ready` with `--set-engine` so the existing mid-execution council (see *Executing a task*) fires at execution time — do **not** convene councils up front
- **recurring** → `ub later` with a return date (or delegate to cron / `schedule` if available); else it stays `ready`

Then emit a one-line **portfolio summary** (counts: ready / deferred / operator-blocked / retry-blocked / fragile) and continue to fit assessment. Keep this pass lightweight — it runs in the owner session, so protect its context.

## Assess fit & choose mode

Before running the loop (in `start`, after gate-routing; skip on `continue` and as a guest), spend one cheap pass deciding **whether** to burn down and in which mode — the loop is one shape of work, not the only one. Read the routed queue (`ub list` + `ub status`) and tally, from fields UB already has: the **fragile fraction** (`risk=high` or `engine∈{rigorous,rigorous-lite}`), the **gate load** (`awaiting_operator` / side-effect / unsatisfied `dependsOn`), the **dated-wait load** (`deferUntil` / `blockedRetryAt`), and the **safe lane** (`ready`, `risk≤low`, independent). Then pick a mode from `references/fit-and-modes.md`:

- **FULL AUTONOMOUS** — weak/no spine, safe lane dominant → UB-canonical, relentless burn-down, `/rigorous` for the few high-risk items.
- **BOUNDED (safe-lane)** — meaningful safe lane but fragile/gated also significant → `ub register --max-risk low`, drain the safe subset to bounded-idle, tee fragile lanes up as serialized `/rigorous` tasks.
- **BOARD-ONLY / SKIP** — strong spine, portfolio mostly gated/fragile → `ub idle --reason "board-only: operator drives"`, run **no** loop; capture stays on.

**Anti-abdication guard:** if any `ready`, low/med-risk, independent task exists, FULL or BOUNDED applies and its safe lane runs **to quiescence before any gate wall is declared** — board-only/skip are for genuinely thin safe lanes, never an excuse to skip executable work. A mostly-gated portfolio reaching gated-rest is a **success state**, not a stalled loop. Re-run this check when the portfolio shape changes.

## The loop

Repeat until quiescent. Between every task, call:

```bash
ub next
```

Four possible responses:

**1. `directive: pause`** → finish the current *atomic step only* (an edit + its verification, a commit, a subtask — not the whole task), then follow `references/pause-resume.md`. In short: GSD project → run `/gsd-pause-work` and set HANDOFF `next_action` to re-enter this skill; then `ub paused --method gsd-pause-work --task <id> --note "<exact position + mental state>"`. Non-GSD → `ub paused --method ub --note "<detailed position>"`. Then tell the Operator the resume steps and **end your turn**. The UI shows them too.

**2. `directive: note`** → a message from the Operator. If it changes current work, apply it now. If it is new work, capture with `--from-operator`. If it's a question, answer briefly and continue.

**2b. `directive: triage`** → captured signals have piled up (the payload lists the oldest). Triage them now — `ub candidates`, promote real work (`--promote <id>`) or dismiss noise (`--dismiss <id> --reason "..."`) — then `ub next` again. Don't sail past them to quiescence; they are work too.

**3. `task`** → execute it (next section). If the response carries `redelivered: true`, this task was **reclaimed** from a session that died mid-work: before doing anything, `ub show <id>` and reconcile against its subtasks/activity/evidence, then continue from where it stopped — do not restart from scratch.

**4. `waiting` / `empty`** → see Quiescence below.

## Executing a task

1. **Read** `instructions` (the intent — Operator text is law) and `plan` (the prepared execution plan). If both are rich, execution should need almost no thinking — that's the point.
2. **If unprepared** (`prepState` none/failed) and the task is not trivial, prepare it *before* marking it in progress — either `ub prep <id>` (the task leaves the pickable set while the planning session runs; take the next task meanwhile), or prepare it yourself when headless is unavailable or the task is urgent: spawn a planner subagent (read-only research/scan/decompose; council of 5 in waves of 2 for genuinely important decisions), then `ub update <id> --set-plan -` (plan markdown on stdin). Trivial tasks skip prep. Headless `ub prep` already emits `acceptanceCriteria` **and** a risk classification — trust them. When you **self**-prepare a plan, or add a med/high-risk task without prep: author 2–4 concrete, objectively-checkable `acceptanceCriteria` yourself (`ub add --criteria "a;;b"` / `ub update --add-criteria`) and set `risk` by the reversibility test (hard-to-reverse / high-blast-radius → high, matching what prep would decide). If a criterion can't be made objectively verifiable, that is a signal to `ub council` / `awaiting_operator`, not to pick arbitrarily.
   A prepared task can legitimately come back **not-ready**: prep routes unanswered operator questions to `awaiting_operator`, and a task that can't run until a wall-clock date/external event to `deferred` with a `deferUntil` (the reconciler auto-returns it when due). That's expected — the loop moves on; don't force such a task to `in_progress`.
3. **Gate check — before you touch `--set-status in_progress`, confirm the task can run *now*.** If it can't, park it with the matching primitive and take the next task instead of burning a pickup (this is the execution-time twin of the ingest gate-routing sweep):
   - **wall-clock** (needs a date/elapsed time) → `ub later <id> --until <ISO>` (defaults to 7d and *guarantees* a reconciler return — use `--until` for precise gates, lean on the default only as a safety net)
   - **transient / estimable-ETA** (quota, rate-limit, deploy-freeze, DNS, external approval) → `ub block <id> --retry-after <min|ISO> --reason "<why>"` (`--reason` required)
   - **human-gated** (permission, credential, decision) → `ub block <id> --operator --reason "<what you need>"` — the *same* `awaiting_operator` terminal as the Side-effect boundary below
   - **dependency** (a prior step must verify first) → ensure `--deps` is set; the server won't surface it until upstreams close
4. When the task truly runs now — and only then — `ub update <id> --set-status in_progress`. (A task marked in_progress and abandoned is invisible to `ub next`; never park one there.)
5. **Route by fragility first, size second** (respect an explicit `engine`; `auto` → decide as below; details + stop-state handling in `references/engines.md`).

   **Fragility / blast-radius gate — evaluate BEFORE the size table.** If the task touches money/payments, auth/authz, prod data, schema/migrations, external send (email/API/webhook), a shared or hot-path file, security, or a file with prior-incident history — **OR** is hard to reverse — route to `/rigorous` (or `/rigorous-lite` only if truly single-file; it auto-promotes to `/rigorous` if risk turns med/high), set `--risk high`, and run it **serialized, never in a parallel wave**, REGARDLESS of file count. A `risk=high` task additionally requires `prep=full` + explicit `acceptanceCriteria` + the adversarial verify in step 8. This is not queue-churn — a high-risk task is *one* serialized `/rigorous` run per repo, residuals harvested for you (`references/rigorous.md`). The Side-effect boundary below is the execution-time enforcement of this same population.

   The size table decides **only** among low-blast-radius, independent, cheaply-verifiable tasks — and for those, a green test suite is necessary but NOT sufficient:

   | Task | Engine |
   |---|---|
   | ≤3 files, one sitting, clean tree | `/gsd-fast "<desc>"` |
   | Small feature/fix, GSD project present | `/gsd-quick <desc>` (add `--validate` if risky) |
   | Belongs to a planned GSD phase | `/gsd-execute-phase N --auto --no-transition` |
   | Root cause unknown | `/gsd-debug` |
   | Fragility gate tripped, single-file | `/rigorous-lite <task>` — see `references/rigorous.md` |
   | Fragility gate tripped, larger / hard-to-reverse | `/rigorous <task>` — see `references/rigorous.md` |
   | Non-code, or no GSD | Direct execution with subagents as needed |

   Never run two GSD engines at once in one repo. Never wrap `/gsd-autonomous` (it is a competing orchestrator).
6. **Wave peers** (`wave.parallel` with `peers`): you may run at most 2 additional peers concurrently — as `Agent(isolation: "worktree")` subagents so each works on an isolated copy — only if their plans touch disjoint files (compare `prep.files`) AND none routes to a GSD engine or Rigorous. **Serialize, don't parallelize, coupled or fragile work:** parallel waves are only for provably disjoint, non-fragile, non-GSD/Rigorous peers, and blast-radius coupling is not always in the file list — if two tasks touch the same fragile hot path, keep them serial even when `prep.files` look disjoint. Integrate results **sequentially**: merge one worktree branch, verify the combined tree, then the next (see `references/engines.md` § Parallel waves). Anything unclear: sequential.
7. **Important decisions mid-execution** (architecture, public contract, schema, security, hard-to-reverse): don't decide alone and don't stall — `ub council <id> --question "..." [--options "a;;b"]` convenes 5 independent voters + synthesis in separate sessions. Keep working something else while it runs; read the result in `ub show <id>` (councils). If synthesis says `needsOperator`, `ub block --operator` with the question. Rigorous-routed tasks already get councils internally — don't double-convene.
8. **Verify** before done — every task, using this checklist: bugs · inefficiencies · incomplete aspects · important considerations · anything missed · anything that should have been done better. For code, run/exercise the change (or `/code-review` / a reviewer subagent for larger diffs). Fix what you find or capture it as follow-up tasks.
   **Risk-tiered done-gate.** For `risk=high` or hot-path tasks (auth, payments, data-migration, security, anything hard to reverse), a green test run is explicitly **NOT** sufficient evidence — they require a **fresh-context adversarial review** before `ub done`: a reviewer subagent seeing only the diff + `acceptanceCriteria` (or the task's stated intent if none are recorded), OR `/code-review`, OR — if routed through `/rigorous` / `/rigorous-lite` — that run's internal councils already satisfy this (don't double-convene). Run **ONE** adversarial pass: fix CRITICAL/HIGH inline, capture everything lower as follow-up tasks, and if the change can't be brought to a defensible state in this one pass, `ub block` it and take the next task — **do not loop indefinitely and do not stall the queue**. Low-risk tasks stay on the lightweight checklist.
9. **Residual sweep**: capture every discovery from this task (including Rigorous out-of-scope/accepted-risk items — see `references/rigorous.md`).
10. `ub done <id> --evidence "-"` with concrete evidence on stdin: what you verified, how, and the result. **For any task with non-empty `acceptanceCriteria`, the evidence must address each criterion 1:1** — that is the verification bar; an unmet criterion means fix or `ub block`, never close. For a `risk=high` / hot-path task the evidence must state, per criterion (or per stated-intent claim), *how* it was adversarially confirmed — not merely that tests passed. (Tasks routed to `/rigorous` or a `/gsd` engine: that engine's own conformance/UAT gate satisfies the adversarial + criteria-author step — don't double-author; the 1:1 done-evidence mapping still applies to `direct`-routed med/high tasks.) Never fabricate evidence; if verification failed, fix or `ub block`. The server gates `done`: it rejects (422) if any subtask is still `open` (finish it, or `ub subtask <id> <subId> skipped` if N/A) or if verification is in a `failed` state — and a *reopened* task needs fresh evidence to re-close. A 422 is a checklist, not an obstacle; satisfy it, don't work around it.
11. Subtasks: mark them as you go (`ub subtask <id> <subId> done`).

**Blocked?** `ub block <id> --reason "..."` (add `--operator` if only the Operator can unblock — approvals, credentials, decisions). Then take the next task; never stall the loop on one task.

**Side-effect boundary:** anything irreversible or outward-facing (deploys, pushes to shared branches, external messages, payments, deletions of user data) → `awaiting_operator` with exact proposed action. Do not proceed on your own.

## Quiescence (when `ub next` returns `waiting` or `empty`)

- `waiting` (prep/peers in flight): use the time — verify a `review`-status task, tighten evidence, or run a mini residual sweep — then call `ub next` again.
- `empty`: the payload lists `review`, `needsOperator`, and dependency-blocked (`depBlocked`) tasks. First, handle every `review` task: the Operator put it there for verification — verify it (checklist above), then `ub done` with evidence or capture fix tasks. Second, triage captured signals: `ub candidates` — promote real work (`--promote <id>`), dismiss noise (`--dismiss <id> --reason`). Third, handle transient blocks: prefer setting `ub block --retry-after <min|ISO> --reason "..."` at block time so they **auto-return** on their own — only manually `ub update <id> --set-status ready` a block that predates that habit and whose reason (quota/rate-limit) has likely reset. On a `strandWarning` (a `depBlocked` task whose upstream will never close), either drop the dep (`--set-deps`) or defer the dependents too — never leave a permanently-stranded task. Then run a **full residual sweep**: scan the conversation for unkept commitments; check `git status`/recent diffs for stray TODO/FIXME; if GSD: `node ~/.claude/gsd-core/bin/gsd-tools.cjs list-todos --cwd .` and `audit-open`; check `.planning/rigorous/INTENT.md` leftovers. Capture anything found and continue the loop.
- A second consecutive clean sweep (no review tasks, no untriaged candidates, no retryable blocks, nothing captured) = genuine quiescence — **which for a gated portfolio means every executable task is done and only gated work remains ("gated-rest"), a first-class success terminal, not a pile of leftover caveats.** Post the final report as **one prioritized operator decision board**: render the `needsOperator` list — every `awaiting_operator`/blocked item with its **exact proposed action** (already required at the side-effect boundary) — **sorted by `waitingHours`, 72h+ items named first**, grouped *at report time* by why it's gated (operator decision / external or wall-clock wait / upstream dependency, read from status + `blockedReason`; no new field). Follow it with the **gate ledger**: each remaining item + gate type + return trigger (date / operator-action / external-ETA). A mostly-operator-gated portfolio is a success state — a standing, aging punch-list the Operator clears in one sitting, not a stalled loop. Then `ub idle` and end your turn. The server **enforces** quiescence: if the queue is not actually quiescent, `ub idle` returns a 409 with an itemized `blockers` list. Treat it as a checklist — clear each item and retry. Never pass `--force`; only the Operator can force-idle (from the UI).
- **Don't over-digest.** Do not interrupt active execution to report; when new `ready` work appears, keep executing. Dated items return on their own via the reconciler — surface them only when they land in `ready`.
- **Stop-guard interplay** (when hooks are installed): ending your turn while the queue is `running` with actionable work gets blocked by the Stop hook — by design. The only clean exits are a completed pause procedure (`ub paused`) or explicit quiescence (`ub idle`). If the guard blocks you, it names the next task — take it.

## Context health

You cannot finish a long queue in one context window, and a degraded context produces degraded work. After completing any large task — or when you notice the session getting heavy — **proactively pause**: follow the pause procedure (as if the Operator pressed the button), hand the Operator the two resume steps, and end the turn. The queue makes resumption lossless; pausing early is strength, not failure.

**High-risk / hot-path tasks must not run deep in an aging session** behind a string of burn-down tasks. When such a task (`risk:high` or hot-path — *not* every `risk:med`, or the non-stop loop fragments into constant pauses) is next up and the session is heavy, **pause first** so a fresh resumed session executes it with clean context; the `--deps` gate guarantees it surfaces alone on resume. Then route it to `/rigorous`, whose separate-session councils do the heavy lifting — but the fresh context comes from the **pause/resume boundary**, not from `/rigorous` itself (it runs inline in the current session via the Skill tool).

## Recurring / cadence work

UB tasks are **one-shot** — `deferUntil` resurfaces a task exactly **once**, not on a cadence. For recurring work (monitor warmup ~day 14, check every deploy, weekly report):

- Capture only the **single next instance** and execute / verify / `ub done` it honestly.
- **NEVER** mark a recurring check "done" as if the whole cadence were satisfied, and never bury "every N days/deploys" inside one task's instructions.
- Put the cadence in an **external scheduler** — `/schedule`, `mcp__scheduled-tasks__*`, or `/loop` — configured to `ub add` the next instance when due, or to re-enter this skill.
- For event-driven cadence with no scheduler wired, capture a standing `ub block --operator` note so it durably surfaces.

Delegating recurrence outward is the honest boundary — do not fake it inside a one-shot task.

## Working style

- The UI is the Operator's window: keep statuses, subtasks, and evidence current so it never lies.
- Tasks the Operator wrote: treat `instructions` as canonical — improve the *plan*, never rewrite their intent.
- Questions for the Operator go in `blockedReason` via `ub block --operator` — the loop keeps moving on other tasks.
- One task at a time gets your full attention; the queue holds everything else so nothing occupies your head.
- **Lanes group; they don't schedule.** A lane = a `lane:<name>` tag on every member + a `--deps` chain over its sequential members (tags give the board a coherent-workstream view; deps preserve order). Tagging is a **triage/prep-time act, not a capture precondition** — capture first with one command, stamp lanes when you triage. Don't invent a tag-based pull policy: class-of-service already maps onto fields `ub next` orders by — expedite → raise `priority`; fixed-date → `ub later --until`; background → low `priority`.
