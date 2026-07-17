#!/usr/bin/env node
// Unfinished Business — Claude Code hook handler.
// Usage (wired by `ub.mjs hooks install`): node hooks.mjs <event>
// Events: session-start | stop | pretool-skill | subagent-stop | pre-compact | post-tool | session-end
//
// Design constraints (non-negotiable):
// - FAST and file-read-only: no server round-trips; reads the store directly.
// - FAIL-OPEN: any error, missing file, or unregistered project → exit 0 silently.
//   A broken hook must never lock the operator out of their own sessions.
// - Never writes server-owned store files. The only writes are one-event JSON
//   files into spool/<projectId>/ (server-consumed) — single-writer preserved.
// - Blocking uses exit code 2 + stderr (works across Claude Code versions).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'UnfinishedBusiness');
const UB = path.join(os.homedir(), '.claude', 'unfinished-business', 'ub.mjs');
const event = process.argv[2];

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function normPath(p) { return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) { data += chunk; if (data.length > 1_000_000) break; }
  return data;
}

function findProject(cwd) {
  if (!cwd) return null;
  const registry = readJson(path.join(ROOT, 'registry.json'));
  if (!registry?.projects?.length) return null;
  const n = normPath(cwd);
  let best = null;
  for (const p of registry.projects) {
    const pp = normPath(p.path);
    if (n === pp || n.startsWith(pp + '/')) {
      if (!best || pp.length > normPath(best.path).length) best = p;
    }
  }
  return best;
}

function store(projectId, name) { return readJson(path.join(ROOT, 'projects', projectId, name)); }

// Block with exit 2 — write via callback so async pipes (POSIX) flush the reason
// before the process dies; a hard timer guarantees exit even if the pipe never
// drains. Sets `blocking` so the main flow's exit(0) stands down.
let blocking = false;
function block(message) {
  blocking = true;
  process.stderr.write(message, () => process.exit(2));
  setTimeout(() => process.exit(2), 500); // deliberately NOT unref'd — must win over natural exit
}

function spool(projectId, ev) {
  try {
    const dir = path.join(ROOT, 'spool', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ev));
    fs.renameSync(tmp, file);
  } catch {}
}

function openTasks(projectId) {
  const tasks = store(projectId, 'tasks.json')?.tasks || [];
  return tasks.filter(t => !['done', 'archived'].includes(t.status));
}

// Mirror a session's live TodoWrite list to tmp/todos/<session>.json (server-IGNORED —
// not the spool). SessionEnd reads it to capture any unfinished items as a candidate,
// so native-todo work is never silently lost when a session ends. Pruned after 7d.
function mirrorTodos(project, payload) {
  try {
    const dir = path.join(ROOT, 'tmp', 'todos');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${payload.session_id || 'unknown'}.json`);
    let prev = readJson(file) || {};
    fs.writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), sessionId: payload.session_id || '', projectId: project.id, todos: payload.tool_input.todos, lastSpooledHash: prev.lastSpooledHash || null }));
    for (const f of fs.readdirSync(dir)) { const fp = path.join(dir, f); try { if (Date.now() - fs.statSync(fp).mtimeMs > 7 * 86400_000) fs.unlinkSync(fp); } catch {} }
  } catch {}
}

// ---------------------------------------------------------------- events
const handlers = {
  'session-start'(payload, project) {
    const control = store(project.id, 'control.json');
    const open = openTasks(project.id);
    const counts = {};
    for (const t of open) counts[t.status] = (counts[t.status] || 0) + 1;
    const lines = [`## Unfinished Business (${project.name})`];
    if (control?.state === 'paused' && control.pausedInfo) {
      const info = control.pausedInfo;
      lines.push(`A paused work loop is waiting (paused ${info.at}, method ${info.method}${info.currentTaskId ? `, task ${info.currentTaskId}` : ''}).`);
      if (info.note) lines.push(`Handoff note: ${String(info.note).slice(0, 300)}`);
      lines.push(`Resume with: /unfinished-business continue`);
    } else if (open.length) {
      const top = open.filter(t => ['inbox', 'ready', 'in_progress'].includes(t.status)).slice(0, 3).map(t => `"${t.title}"`).join(', ');
      lines.push(`${open.length} open task(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.${top ? ` Next up: ${top}.` : ''}`);
      const aged = open.filter(t => t.slaFlag).sort((a, b) => b.slaFlag - a.slaFlag);
      if (aged.length) lines.push(`⏳ ${aged.length} task(s) have been waiting on the operator ${aged[0].slaFlag}h+: ${aged.slice(0, 2).map(t => `"${t.title}"`).join(', ')}.`);
      const orphans = open.filter(t => t.orphanFlag);
      if (orphans.length) lines.push(`⚠ ${orphans.length} in_progress task(s) look orphaned (no active loop): ${orphans.slice(0, 2).map(t => `"${t.title}"`).join(', ')} — reconcile or reset.`);
      lines.push(`Work the queue with /unfinished-business, or capture new items via: node "${UB}" add "..." --context "..."`);
    } else {
      // ALWAYS prime the capture rule — a fresh session must learn capture exists
      // even when the queue is empty (a discovery here would otherwise be lost)
      lines.push(`No open tasks queued. Capture any unfinished work the moment you find it — it survives /clear: node "${UB}" add "..." --context "..."`);
    }
    // After compaction, the task record (not the truncated context) is the source of
    // truth: re-inject the current task's open subtasks + acceptance criteria verbatim.
    if (payload.source === 'compact' && control?.state === 'running' && control?.session?.id === payload.session_id) {
      const cur = open.find(t => t.status === 'in_progress');
      if (cur) {
        lines.push(`\nAfter compaction: task "${cur.title}" (${cur.id}) is the source of truth — \`node "${UB}" show ${cur.id}\` before continuing, do not trust memory.`);
        const subs = (cur.subtasks || []).filter(s => s.status === 'open').map(s => `  - ${s.title}`);
        if (subs.length) lines.push(`Open subtasks:\n${subs.join('\n')}`);
        const crit = (cur.acceptanceCriteria || []).map(c => `  - ${c}`);
        if (crit.length) lines.push(`Acceptance criteria:\n${crit.join('\n')}`);
      }
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
    }));
  },

  // When a session ends (clear/logout/exit), capture any unfinished native TODO items
  // as ONE candidate so they are not lost. Fires ONCE — unlike Stop (every turn) —
  // so it cannot flood the candidate cap. Deduped by content hash.
  'session-end'(payload, project) {
    const file = path.join(ROOT, 'tmp', 'todos', `${payload.session_id || 'unknown'}.json`);
    const data = readJson(file);
    if (!data?.todos) return;
    const unfinished = data.todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
    if (!unfinished.length) return;
    const hash = crypto.createHash('sha256').update(JSON.stringify(unfinished.map(t => t.content))).digest('hex').slice(0, 16);
    if (data.lastSpooledHash === hash) return; // already captured this exact set
    spool(project.id, {
      kind: 'other', ts: new Date().toISOString(), sessionId: payload.session_id || '',
      summary: `Session ended with ${unfinished.length} unfinished TODO item(s): ${unfinished.map(t => t.content).slice(0, 8).join(' | ')}`,
    });
    try { data.lastSpooledHash = hash; fs.writeFileSync(file, JSON.stringify(data)); } catch {}
  },

  stop(payload, project) {
    if (payload.stop_hook_active === true) return; // never loop
    const control = store(project.id, 'control.json');
    if (!control?.session?.id) return;
    // A sess- fallback owner registered WITHOUT a real CLAUDE_CODE_SESSION_ID, so
    // its id can never equal payload.session_id — leaving the working session
    // unguarded. Presume the stopping session IS that owner (bounded by the same
    // 50min fail-open the GSD gate uses). Because the second stop always passes
    // (stop_hook_active cap), a guest doing unrelated work self-resolves in ONE
    // bounce and is never baited into `ub next` (which would steal the loop).
    const idMatches = control.session.id === payload.session_id;
    const seen = control.session.lastSeen ? Date.now() - Date.parse(control.session.lastSeen) : Infinity;
    const sessFallbackOwner = String(control.session.id).startsWith('sess-')
      && ['running', 'pause_requested'].includes(control.state) && seen < 50 * 60_000;
    if (!idMatches && !sessFallbackOwner) return;
    const guestSuffix = idMatches ? '' : ' (If you are a DIFFERENT session doing unrelated work, just stop again — you will exit cleanly.)';
    if (control.state === 'pause_requested') {
      return block(`Unfinished Business: a pause was requested from the UI. Run the pause procedure now (finish the atomic step, checkpoint, then \`node "${UB}" paused\`) before stopping.${guestSuffix}`);
    }
    if (control.state !== 'running') return;
    const open = openTasks(project.id);
    const openIds = new Set(open.map(t => t.id));
    // mirror pickNext: runnable = inbox/ready, deps satisfied, prep not in flight
    const actionable = open.filter(t => ['inbox', 'ready'].includes(t.status)
      && !['queued', 'running'].includes(t.prep?.state)
      && (t.dependsOn || []).every(d => !openIds.has(d)));
    const directives = (control.directives || []).filter(d => !d.consumedAt);
    const midTask = open.filter(t => t.status === 'in_progress');
    const prepInFlight = open.filter(t => ['queued', 'running'].includes(t.prep?.state) || t.status === 'preparing');
    const review = open.filter(t => t.status === 'review');
    const untriaged = (store(project.id, 'candidates.json')?.items || []).filter(c => !c.dismissed && !c.promotedTaskId);
    const exitHint = `The only clean exits are a completed pause (\`node "${UB}" paused\`) or explicit quiescence (/unfinished-business stop → \`node "${UB}" idle\`).`;
    if (midTask.length) {
      return block(`Unfinished Business: task "${midTask[0].title}" is still in_progress — finish it, block it with a reason, or run the pause procedure. ${exitHint}${guestSuffix}`);
    }
    if (actionable.length || directives.length) {
      const head = actionable[0]?.title || 'pending operator directive';
      return block(`Unfinished Business: the queue still has ${actionable.length || directives.length} actionable item(s) — next: "${head}". Continue the loop: node "${UB}" next. ${exitHint}${guestSuffix}`);
    }
    if (prepInFlight.length || review.length) {
      return block(`Unfinished Business: ${prepInFlight.length ? `${prepInFlight.length} task(s) are being prepared and will be ready shortly` : `${review.length} task(s) sit in review awaiting verification`} — keep the loop alive (\`node "${UB}" next\`, use the wait productively) or pause properly. ${exitHint}${guestSuffix}`);
    }
    // captured signals are work too — a session must not exit "clean" over untriaged debt
    if (untriaged.length) {
      return block(`Unfinished Business: ${untriaged.length} captured signal(s) await triage — run \`node "${UB}" candidates\` and promote or dismiss each before stopping. ${exitHint}${guestSuffix}`);
    }
  },

  'pretool-skill'(payload, project) {
    if (payload.tool_name !== 'Skill') return;
    const skill = String(payload.tool_input?.skill || '');
    if (!/^(gsd-|rigorous)/.test(skill)) return;
    if (['gsd-help', 'gsd-pause-work', 'gsd-resume-work', 'gsd-progress', 'gsd-stats', 'gsd-health'].includes(skill)) return;
    const control = store(project.id, 'control.json');
    if (control?.state !== 'running' || !control?.session?.id) return;
    if (control.session.id === payload.session_id) return; // the owner may orchestrate
    // the server persists heartbeats ~every 60s while alive; 50min > the 45min
    // watchdog, so a session this stale on disk is the watchdog's job, not ours
    const seen = control.session.lastSeen ? Date.now() - Date.parse(control.session.lastSeen) : Infinity;
    if (seen > 50 * 60_000) return; // fail-open on a dead owner
    block(
      `Unfinished Business: session ${control.session.id} is actively orchestrating this repository (last seen ${Math.round(seen / 60000)}m ago). ` +
      `Running ${skill} here too risks two orchestrators fighting over GSD state. Pause the queue from the UB UI first, or wait for it to go idle.`,
    );
  },

  'subagent-stop'(payload, project) {
    // The working session's own subagents are already covered by its capture rule —
    // spooling them would make the quiescence sweep regenerate its own triage work.
    const control = store(project.id, 'control.json');
    if (control?.session?.id && control.session.id === payload.session_id) return;
    // Best effort: pull the subagent's final text from its own transcript tail.
    // No fallback to the parent transcript — that captures the wrong speaker.
    let summary = '';
    try {
      const tp = payload.agent_transcript_path;
      if (tp && fs.existsSync(tp)) {
        const size = fs.statSync(tp).size;
        const fd = fs.openSync(tp, 'r');
        const len = Math.min(size, 64_000);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').filter(Boolean).reverse();
        for (const line of lines) {
          try {
            const j = JSON.parse(line);
            if (j?.type !== 'assistant' && j?.message?.role !== 'assistant') continue; // only the subagent's own words
            const content = j?.message?.content;
            const text = Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join(' ') : typeof content === 'string' ? content : '';
            if (text && text.trim().length > 40) { summary = text.trim(); break; }
          } catch {}
        }
      }
    } catch {}
    if (!summary) return; // no signal — no noise
    spool(project.id, {
      kind: 'subagent', ts: new Date().toISOString(), sessionId: payload.session_id || '',
      summary: `Subagent result (review for uncaptured follow-ups): ${summary.slice(0, 1200)}`,
    });
  },

  'pre-compact'(payload, project) {
    const control = store(project.id, 'control.json');
    if (control?.session?.id !== payload.session_id) return; // only the working session matters
    spool(project.id, {
      kind: 'compact', ts: new Date().toISOString(), sessionId: payload.session_id || '',
      summary: 'Working session compacted mid-loop — after compaction, re-read the current task record (ub show) before continuing; the task record, not memory, is the source of truth.',
    });
  },

  // Heartbeat: a long engine run (rigorous, gsd-execute-phase) can make no ub API
  // calls for >45min and get false-idled by the watchdog — disarming the stop guard
  // and opening the GSD gate. PostToolUse lets the OWNER prove liveness cheaply.
  // Throttled against on-disk lastSeen (never stat spool files — the server unlinks
  // them every ~10s, so a spool marker vanishes each cycle).
  'post-tool'(payload, project) {
    // (a) mirror native TODO lists for ANY session (SessionEnd captures unfinished ones)
    if (payload.tool_name === 'TodoWrite' && Array.isArray(payload.tool_input?.todos)) mirrorTodos(project, payload);
    // (b) heartbeat — owner only
    const control = store(project.id, 'control.json');
    if (control?.state !== 'running' || !control?.session?.id) return;
    if (control.session.id !== payload.session_id) return; // only the registered owner heartbeats
    const seen = control.session.lastSeen ? Date.now() - Date.parse(control.session.lastSeen) : Infinity;
    if (seen < 5 * 60_000) return; // fresh enough — the loop's own API calls cover liveness
    spool(project.id, { kind: 'heartbeat', ts: new Date().toISOString(), sessionId: payload.session_id || '' });
  },
};

// ---------------------------------------------------------------- main
try {
  const raw = await readStdin();
  const payload = raw ? JSON.parse(raw) : {};
  const project = findProject(payload.cwd || process.cwd());
  if (project && handlers[event]) handlers[event](payload, project);
} catch {}
if (!blocking) {
  // let stdout (SessionStart context) flush, then exit cleanly
  process.stdout.write('', () => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}
