# Engine routing — details and stop-state handling

How Unfinished Business dispatches tasks through the GSD engines installed on this machine, and how to interpret every way they stop. Ground rules first:

- **Fragility before size.** The size-keyed rows below apply *only* to low-blast-radius, independent, cheaply-verifiable tasks. Anything touching money/payments, auth/authz, prod data, schema/migrations, external send, security, or a shared/hot-path/prior-incident file — or that is hard to reverse — routes to `/rigorous` (`/rigorous-lite` only if truly single-file), `--risk high`, serialized, **regardless of file count** (see SKILL.md *Executing a task* → the fragility/blast-radius gate). A green test suite is necessary but not sufficient for that class.
- **One engine at a time per repository.** GSD's STATE.md/ROADMAP.md are single-writer; worktree manifests assume one orchestrator.
- **Long engine runs stay "alive" automatically.** A `/gsd-execute-phase` or `/rigorous` run can go 45+ min without any `ub` call. With hooks installed, a PostToolUse heartbeat proves the owning session is alive, so the server does not false-idle it (which would disarm the stop guard and open the GSD gate). You do not need to poke `ub next` to stay alive — but if hooks are NOT installed, prefer a periodic `ub next` during very long runs.
- **Clean tree before `/gsd-fast`** — it commits with `git add -A`, which sweeps *any* dirty file into its commit. `git status` first; if dirty with unrelated changes, use `/gsd-quick` or direct execution instead.
- GSD presence check: `.planning/` exists → `node ~/.claude/gsd-core/bin/gsd-tools.cjs state load --cwd . --json-errors` → read `config_exists / roadmap_exists / state_exists`.
- Machine-readable status (never parse engine prose when a query exists): `state json`, `roadmap analyze`, `phase-plan-index <n>`, `list-todos`, `audit-open`, `verification status <phase_dir>` — all via `gsd-tools.cjs ... --cwd .`.

## /gsd-fast

- Invoke: `/gsd-fast "<one-sentence task>"` — always pass the description.
- Scope gate: ≤3 file edits, ~minutes, no research/architecture. If it replies "This looks like it needs planning. Use /gsd-quick" — that is a **routing signal, not an error**: re-route the task to gsd-quick.
- Commits one atomic conventional commit directly on the current branch.

## /gsd-quick

- Invoke: `/gsd-quick <description>`; flags: `--validate` (adds plan-checker + verifier; may prompt on persistent gaps), `--research`, `--full`. Default (no flags) has **no interactive gates** on the happy path — best for the loop.
- Requires `.planning/ROADMAP.md` (a GSD project). Without one, only gsd-fast or direct execution are available.
- Artifacts land in `.planning/quick/<id>-<slug>/`; executor commits code atomically, orchestrator commits docs.
- May run on a config-driven quick-task branch — check `git branch --show-current` after; note it in evidence.
- Resume a stalled one: `/gsd-quick resume <slug>`; list: `/gsd-quick list`.

## /gsd-execute-phase

- Invoke: `/gsd-execute-phase <N> --auto --no-transition`. **Always `--no-transition`** — UB owns sequencing; without it a passed phase chains into the next phase on its own.
- Pre-flight: `gsd-tools.cjs phase-plan-index <N> --cwd .` — dispatch unattended only if every plan has `autonomous: true` and no human-action checkpoints; otherwise mark the task `awaiting_operator` ("phase N has human gates").
- `--auto` auto-resolves human-verify/decision checkpoints (decision = first option — acceptable only for pre-classified low-risk phases).
- Stop states to detect and handle:
  - `## PHASE COMPLETE` → verify, then done.
  - "Human Verification Needed" + `{phase}-UAT.md` → `ub block <id> --operator --reason "phase N needs /gsd-verify-work"`.
  - "Gaps Found" → capture a follow-up task: `/gsd-plan-phase N --gaps` then `/gsd-execute-phase N --gaps-only`.
  - Quota/rate-limit halt (`agent.classify-failure` says quota) → `ub block <id> --retry-after <ISO> --reason "provider quota — retry after reset"` so it **auto-returns** to `ready` when the window resets (don't leave it needing a manual retry); move on.
  - Post-merge test failure / regression prompt → treat as blocked, capture a fix task with the failure output.
- Re-invocation resumes automatically (skips plans that already have SUMMARY.md).

## /gsd-debug

- For tasks whose root cause is unknown. Maintains its own debug state across resets — safe to pause around.

## /gsd-autonomous — do not use inside the loop

It is itself a multi-phase orchestrator with intentional human pauses (discuss tables, gap decisions, audits). Running it inside UB double-orchestrates. If the Operator explicitly wants it, hand the whole session over to it instead of the UB loop, and say so.

## Direct execution (no GSD, or non-code work)

Execute inline or with subagents; commit logically if in a git repo; verification checklist still applies; evidence still required.

## Parallel waves of direct tasks (worktree protocol)

When a wave marks peers parallel-eligible and all are `direct`-route:

1. **Pre-check**: compare each peer's `prep.files` (planner's files-likely-touched). Any overlap, **any peer whose `prep.files` is missing or empty** (self-prepared plans don't populate it), any peer without a plan, or any peer routing to GSD/Rigorous → run sequentially instead.
2. **Dispatch**: up to 2 peers as `Agent(isolation: "worktree")` subagents, each with its task's full plan + instructions in the prompt, told to commit its work in its worktree, and **required to end its final message with the exact branch name and worktree path it worked on** (`git branch --show-current` + `git rev-parse --show-toplevel`). Keep working the primary task yourself meanwhile.
3. **Integrate sequentially, never in parallel**: when a peer finishes, take the branch name from its report (`git worktree list` / `git branch --list 'worktree-*'` to cross-check), then from the main tree: `git merge --no-ff <branch>` → run the combined verification (build/tests + the peer's acceptance criteria against the merged tree) → `ub done` that peer with merged-tree evidence. Only then integrate the next. A conflict → `git merge --abort`, `ub block` the task with the conflict details; never resolve destructively.
4. A peer's `done` evidence must come from the **merged** tree, not its isolated worktree.

## Failure classification

On any engine failure, before retrying: `gsd-tools.cjs agent classify-failure` distinguishes quota (wait, never retry-now), the known `classifyHandoffIfNeeded` false-failure (spot-check SUMMARY.md + commits — often actually succeeded), and unknown (investigate once, then block with details). Never blind-retry a failed engine run.
