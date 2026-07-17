#!/usr/bin/env node
// Unfinished Business — durable local server.
// Zero dependencies (Node 22 stdlib). Single writer to the store.
// Owns: task store, audit log, schedule, control state (pause/directives),
// SSE live updates, and the headless-session job runner (prep / order).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UI_COOKIE_NAME, createLaunchTickets, publicProjects, readCookie } from './security.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';
const requestedPort = Number(process.env.UB_PORT ?? 47821);
const PREFERRED_PORT = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 47821;
const MAX_SESSIONS = 2;            // physical cap on concurrent headless sessions
const JOB_TIMEOUTS = { prepare_full: 20 * 60_000, prepare_quick: 8 * 60_000, order: 6 * 60_000 };
const JOB_RETRIES = 2;
const RETRY_BACKOFF_MS = [15_000, 60_000];

// ---------------------------------------------------------------- store paths
const ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'UnfinishedBusiness');
const SERVER_JSON = path.join(ROOT, 'server.json');
const REGISTRY_JSON = path.join(ROOT, 'registry.json');
const LOG_FILE = path.join(ROOT, 'server.log');

fs.mkdirSync(ROOT, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  process.stdout.write(line);
}

// Write + fsync: force the bytes to disk before the rename, so a power loss cannot
// persist the rename ahead of the data (which would zero the file). Directory fsync
// is unavailable on win32; file-level durability is the achievable win.
function writeSyncFsync(file, content) {
  const fd = fs.openSync(file, 'w');
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function appendSyncFsync(file, content) {
  const fd = fs.openSync(file, 'a');
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeSyncFsync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(raw); } catch {
    // never silently reset a corrupt store — preserve it for manual recovery
    const backup = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, backup); } catch {}
    log(`WARNING: ${file} is corrupt — preserved as ${backup}, starting from empty`);
    return fallback;
  }
}

// Like readJson but DISTINGUISHES a missing file (fine — a new project) from a
// corrupt one (parse failure — the project must enter SAFE MODE so the corrupt
// bytes are never overwritten by an empty in-memory store).
function readStorePart(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { data: fallback, degraded: false }; }
  try { return { data: JSON.parse(raw), degraded: false }; }
  catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, backup); } catch {}
    log(`WARNING: ${file} is corrupt — preserved as ${backup}; project entering SAFE MODE (mutations paused until recovery)`);
    return { data: fallback, degraded: true };
  }
}

process.on('uncaughtException', e => log('UNCAUGHT', e?.stack || String(e)));
process.on('unhandledRejection', e => log('UNHANDLED REJECTION', e?.stack || String(e)));

// ULID-ish sortable id: ms timestamp base36 + random
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

function normProjectPath(p) {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
function projectIdFor(p) {
  return crypto.createHash('sha256').update(normProjectPath(p)).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------- in-memory state
const registry = readJson(REGISTRY_JSON, { projects: [] });
const projects = new Map(); // id -> { tasks, schedule, jobs, control, dir, meta, seq }
const sseClients = new Map(); // projectId -> Set<res>

function projectDir(id) { return path.join(ROOT, 'projects', id); }

const DEFAULT_SETTINGS = { autoApplySchedule: true };

function loadProject(id) {
  if (projects.has(id)) return projects.get(id);
  const meta = registry.projects.find(p => p.id === id);
  if (!meta) return null;
  const dir = projectDir(id);
  let degraded = false;
  const part = (name, fallback) => { const r = readStorePart(path.join(dir, `${name}.json`), fallback); if (r.degraded) degraded = true; return r.data; };
  const st = {
    id, dir, meta,
    tasks: part('tasks', { tasks: [], seq: 0 }),
    schedule: part('schedule', { active: null, pending: null, history: [] }),
    jobs: part('jobs', { jobs: [] }),
    control: part('control', { state: 'idle', directives: [], session: null, pausedInfo: null }),
    candidates: part('candidates', { items: [] }),
    questions: part('questions', { items: [] }),
    degraded, // SAFE MODE — set BEFORE backupProject so a corrupt store is never snapshotted
  };
  if (degraded) log(`project ${id} loaded in SAFE MODE — writes paused until operator recovery`);
  st.control.settings = { ...DEFAULT_SETTINGS, ...(st.control.settings || {}) };
  // after a server restart, give a 'running' session the benefit of the doubt —
  // its heartbeats only lived in the dead server's memory
  if (st.control.state === 'running' && st.control.session) st.control.session.lastSeen = new Date().toISOString();
  // recover jobs that were 'running' when the server died
  for (const j of st.jobs.jobs) {
    if (j.state === 'running') { j.state = 'queued'; j.note = 'requeued after server restart'; }
  }
  loadLastAudit(st);
  projects.set(id, st);
  recoverInterruptedSave(st);
  backupProject(st);
  return st;
}

// Multi-part saves are guarded by a write-ahead intent marker (council-recommended,
// v3): stage every part to a temp file first, record the intent, then rename all —
// shrinking the cross-file inconsistency window from "several serialized writes"
// to microseconds, and making any crash inside it DETECTED on the next boot
// (see recoverInterruptedSave) instead of silent.
function saveProject(st, parts = ['tasks', 'schedule', 'jobs', 'control', 'candidates', 'questions']) {
  // SAFE MODE: never overwrite a store whose on-disk copy we could not parse — an
  // empty/partial in-memory image would destroy the recoverable data. This one guard
  // covers every writer (routes, ingestSpool, heartbeat persister, scheduler, jobs).
  if (st.degraded) return;
  if (parts.length === 1) { atomicWrite(path.join(st.dir, `${parts[0]}.json`), st[parts[0]]); return; }
  const staged = [];
  for (const part of parts) {
    const target = path.join(st.dir, `${part}.json`);
    const tmp = `${target}.staged-${process.pid}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeSyncFsync(tmp, JSON.stringify(st[part], null, 2));
    staged.push({ tmp, target });
  }
  const intent = path.join(st.dir, 'save-intent.json');
  writeSyncFsync(intent, JSON.stringify({ parts, ts: new Date().toISOString(), pid: process.pid }));
  for (const { tmp, target } of staged) fs.renameSync(tmp, target);
  fs.unlinkSync(intent);
}

// A leftover save-intent.json means the process died between the staged renames:
// individual files are valid JSON, but they may not be from the same save. Preserve
// the evidence, surface it, and continue — the domain guards (job requeue, prep
// failure recovery, revision checks) tolerate cross-file drift.
function recoverInterruptedSave(st) {
  const intent = path.join(st.dir, 'save-intent.json');
  if (!fs.existsSync(intent)) return;
  try {
    const info = readJson(intent, {});
    const dir = path.join(st.dir, `recovery-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of STORE_FILES) {
      const src = path.join(st.dir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
    }
    fs.unlinkSync(intent);
    log(`project ${st.id}: interrupted save detected (intent from ${info.ts}) — store snapshot preserved at ${dir}`);
    audit(st, 'system', 'store:interrupted-save-recovered', { intent: info, snapshot: path.basename(dir) });
  } catch (e) { log('recovery of interrupted save failed', String(e)); }
}

// -------------------------------------------------------------- hook event spool
// Hooks (running inside arbitrary Claude sessions) never write server-owned files.
// They drop one small JSON file per event into spool/<projectId>/; the server is
// the sole consumer: ingest -> candidates -> delete. Malformed files go to .bad/.
const SPOOL_ROOT = path.join(ROOT, 'spool');

// Capture caps must never SILENTLY delete an untriaged signal (the whole system
// promises nothing is lost). When the candidate list overflows, evict already-
// triaged items (dismissed or promoted) first; only if that is not enough do we
// touch untriaged items — and those are appended to a durable on-disk archive
// before removal, with a counter the operator can see and clear.
const CANDIDATE_CAP = 200;
const QUESTION_CAP = 50;

function appendArchive(st, file, rows, reason) {
  if (!rows.length) return;
  try {
    const now = new Date().toISOString();
    fs.appendFileSync(path.join(st.dir, file),
      rows.map(r => JSON.stringify({ ...r, archivedAt: now, archiveReason: reason })).join('\n') + '\n');
  } catch (e) { log('archive append failed', st.id, file, String(e)); }
}

function trimCandidates(st) {
  const items = st.candidates.items;
  let overflow = items.length - CANDIDATE_CAP;
  if (overflow <= 0) return;
  const isSafe = c => c.dismissed || c.promotedTaskId; // triaged — no untriaged signal to lose
  const remove = new Set();
  for (const c of items) { if (overflow <= 0) break; if (isSafe(c)) { remove.add(c); overflow--; } } // oldest safe first
  const archived = [];
  for (const c of items) { if (overflow <= 0) break; if (!remove.has(c) && !isSafe(c)) { remove.add(c); archived.push(c); overflow--; } }
  if (archived.length) {
    appendArchive(st, 'candidates-archive.jsonl', archived, 'cap-overflow-unreviewed');
    const ca = st.control.candidateArchive || (st.control.candidateArchive = { total: 0, unseen: 0 });
    ca.total += archived.length; ca.unseen += archived.length;
    audit(st, 'system', 'candidates:archived-unreviewed', { count: archived.length });
  }
  if (remove.size) st.candidates.items = items.filter(c => !remove.has(c));
}

function trimQuestions(st) {
  const items = st.questions.items;
  let overflow = items.length - QUESTION_CAP;
  if (overflow <= 0) return;
  const isActive = q => ['queued', 'running'].includes(q.state); // never evict an in-flight answer
  const remove = new Set(), archived = [];
  for (const q of items) { if (overflow <= 0) break; if (!isActive(q)) { remove.add(q); archived.push(q); overflow--; } }
  if (archived.length) {
    appendArchive(st, 'questions-archive.jsonl', archived, 'cap-overflow');
    audit(st, 'system', 'questions:archived', { count: archived.length });
  }
  if (remove.size) st.questions.items = items.filter(q => !remove.has(q));
}

function ingestSpool() {
  let dirs = [];
  try { dirs = fs.readdirSync(SPOOL_ROOT); } catch { return; }
  for (const projectId of dirs) {
    if (projectId === '.bad') continue;
    const st = loadProject(projectId);
    if (!st) continue; // unknown project (e.g. registry recovering) — leave events for later, never discard
    if (st.degraded) continue; // SAFE MODE: leave spool files intact — ingest would push a candidate then fail to persist it (saveProject is a no-op while degraded), losing the capture. Sync after recovery.
    const dir = path.join(SPOOL_ROOT, projectId);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { continue; }
    if (!files.length) continue;
    let added = 0, controlDirty = false;
    for (const f of files.slice(0, 100)) {
      const fp = path.join(dir, f);
      try {
        const ev = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (ev.kind === 'heartbeat') {
          // liveness only — refresh lastSeen when the id matches the registered owner.
          // NEVER create control.session (re-adoption at /api/next is the sole creator)
          // and never a candidate. hooksLive lets the watchdog tighten its window.
          if (st.control.session && ev.sessionId && st.control.session.id === ev.sessionId) {
            st.control.session.lastSeen = new Date().toISOString();
            st.control.hooksLive = true;
            controlDirty = true;
          }
          fs.unlinkSync(fp);
          continue;
        }
        if (typeof ev.summary === 'string' && ev.summary.trim()) {
          st.candidates.items.push({
            id: newId('cand'),
            ts: typeof ev.ts === 'string' ? ev.ts : new Date().toISOString(),
            kind: ['subagent', 'compact', 'other'].includes(ev.kind) ? ev.kind : 'other',
            summary: ev.summary.slice(0, 2000),
            sessionId: String(ev.sessionId || '').slice(0, 64),
            dismissed: null, promotedTaskId: null,
          });
          added++;
        }
        fs.unlinkSync(fp);
      } catch {
        try {
          fs.mkdirSync(path.join(SPOOL_ROOT, '.bad'), { recursive: true });
          fs.renameSync(fp, path.join(SPOOL_ROOT, '.bad', `${projectId}-${f}`));
        } catch {}
      }
    }
    if (added) {
      trimCandidates(st);
      audit(st, 'hook', 'candidates:ingested', { count: added });
      touch(st, ['candidates', 'control'], 'candidates');
    } else if (controlDirty) {
      touch(st, ['control'], 'control'); // persist refreshed lastSeen so hooks read it fresh
    }
  }
}

// The offline outbox: `ub add`/MCP write full task events here (with their own
// projectPath) when the server is unreachable, so a capture is never lost to a
// down server. The server is the sole consumer: resolve/register the project,
// dedupe, create via the shared path. Unresolvable events quarantine to .bad/.
// Write a task-capture event to the durable outbox (used by the SAFE-MODE capture
// exception). ingestTaskOutbox will pick it up once the project is no longer degraded.
function spoolTaskServerSide(st, body) {
  const dir = path.join(SPOOL_ROOT, '_tasks');
  fs.mkdirSync(dir, { recursive: true });
  const dedupeKey = body.dedupeKey || crypto.createHash('sha256').update(`${body.title}\0${body.source?.context || ''}\0server`).digest('hex').slice(0, 16);
  const file = path.join(dir, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.json`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ kind: 'task', payload: body, projectPath: st.meta.path, dedupeKey, ts: new Date().toISOString() }));
  fs.renameSync(tmp, file);
}

function ingestTaskOutbox() {
  const dir = path.join(SPOOL_ROOT, '_tasks');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return; }
  for (const f of files.slice(0, 100)) {
    const fp = path.join(dir, f);
    try {
      const ev = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const pth = ev.projectPath;
      if (!pth || !fs.existsSync(pth)) throw new Error('unresolvable projectPath');
      const id = projectIdFor(pth);
      if (!registry.projects.find(x => x.id === id)) {
        const meta = { id, path: path.resolve(pth), name: path.basename(path.resolve(pth)), createdAt: new Date().toISOString() };
        registry.projects.push(meta);
        atomicWrite(REGISTRY_JSON, registry);
        fs.mkdirSync(projectDir(id), { recursive: true });
      }
      const st = loadProject(id);
      if (!st) throw new Error('project load failed');
      if (st.degraded) continue; // leave the event spooled until the project recovers
      const key = linkedDedupeKey(ev.payload?.linkedSource) || ev.dedupeKey;
      if (!dedupeLookup(st, key)) {
        const task = createTaskFromInput(st, ev.payload || {}, 'claude', key);
        audit(st, 'system', 'task:synced-from-outbox', { taskId: task.id, spooledAt: ev.ts });
        touch(st, ['tasks'], 'task-created');
      }
      fs.unlinkSync(fp);
    } catch {
      try {
        fs.mkdirSync(path.join(SPOOL_ROOT, '.bad'), { recursive: true });
        fs.renameSync(fp, path.join(SPOOL_ROOT, '.bad', `_tasks-${f}`));
      } catch {}
    }
  }
}
setInterval(() => { ingestSpool(); ingestTaskOutbox(); }, 10_000).unref();

// Audit events form a hash chain: hash = sha256(prevHash + canonical(event)).
// `ub verify-audit` walks the chain; a legacy (pre-chain) prefix is tolerated.
function loadLastAudit(st) {
  st.lastAudit = { seq: 0, hash: null };
  try {
    const file = path.join(st.dir, 'audit.jsonl');
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 32_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (j.hash) { st.lastAudit = { seq: j.seq || 0, hash: j.hash }; break; }
      } catch {}
    }
  } catch {}
  return st.lastAudit;
}

function audit(st, actor, action, detail) {
  const prev = st.lastAudit || loadLastAudit(st);
  // An oversized event line would defeat loadLastAudit's tail read — but truncating
  // discards data that could be needed to reconstruct a lost task. Instead, spill the
  // full detail to an audit-blob and reference it, so nothing is lost yet the line
  // stays small.
  const dstr = JSON.stringify(detail ?? null);
  if (dstr && dstr.length > 2000) {
    try {
      const bhash = crypto.createHash('sha256').update(dstr).digest('hex').slice(0, 16);
      const blobDir = path.join(st.dir, 'artifacts', 'audit-blobs');
      fs.mkdirSync(blobDir, { recursive: true });
      writeSyncFsync(path.join(blobDir, `${bhash}.json`), dstr);
      detail = { blobRef: bhash, preview: dstr.slice(0, 300) };
    } catch { detail = { truncated: true, preview: dstr.slice(0, 1500) }; }
  }
  const base = { seq: (prev.seq || 0) + 1, ts: new Date().toISOString(), actor, action, detail, prev: prev.hash || null };
  const hash = crypto.createHash('sha256').update((prev.hash || '') + JSON.stringify(base)).digest('hex').slice(0, 32);
  const ev = { ...base, hash };
  // Append BEFORE advancing lastAudit: if the append fails, we must NOT advance (that
  // would fork the hash chain and make verify-audit misreport tampering). Retry once;
  // on final failure drop the event and raise auditBroken.
  const line = JSON.stringify(ev) + '\n';
  let appended = false;
  for (let attempt = 0; attempt < 2 && !appended; attempt++) {
    try { appendSyncFsync(path.join(st.dir, 'audit.jsonl'), line); appended = true; } catch (e) { if (attempt) log('audit append failed twice', st.id, String(e)); }
  }
  if (appended) { st.lastAudit = { seq: base.seq, hash }; if (st.auditBroken) st.auditBroken = false; }
  else st.auditBroken = true; // chain head NOT advanced — event dropped, not forked
  return ev;
}

// Rotating store backups: on project load and every 6h. Keep the newest 5.
const STORE_FILES = ['tasks.json', 'schedule.json', 'jobs.json', 'control.json', 'candidates.json', 'questions.json'];
function backupProject(st) {
  if (st.degraded) return; // never snapshot a corrupt/partial store as a "good" backup
  try {
    // don't let restart-heavy incident debugging rotate away pre-incident backups
    const bdir = path.join(st.dir, 'backups');
    const existing = fs.existsSync(bdir) ? fs.readdirSync(bdir).sort() : [];
    const newest = existing.at(-1);
    if (newest && Date.now() - fs.statSync(path.join(bdir, newest)).mtimeMs < 3600_000) return;
    const dir = path.join(st.dir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of STORE_FILES) {
      const src = path.join(st.dir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
    }
    // anchor the audit chain head with this backup — `ub restore` reports events after
    // it. Never anchor a KNOWN-broken chain (a bad chain must not become a restore anchor).
    if (!st.auditBroken) { try { fs.writeFileSync(path.join(dir, 'audit-anchor.json'), JSON.stringify({ seq: st.lastAudit?.seq || 0, hash: st.lastAudit?.hash || null, ts: new Date().toISOString() })); } catch {} }
    const all = fs.readdirSync(path.join(st.dir, 'backups')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 5))) {
      fs.rmSync(path.join(st.dir, 'backups', old), { recursive: true, force: true });
    }
  } catch (e) { log('backup failed', st.id, String(e)); }
}
setInterval(() => { for (const st of projects.values()) backupProject(st); }, 6 * 3600_000).unref();

// Session liveness: a 'running' session that has not heartbeated in the stale
// window goes idle — a dead session must not hold the GSD gate closed or make the
// UI claim work is happening. The window is ADAPTIVE: 45 min for hook-less installs
// (a long engine run makes no ub calls), but once PostToolUse heartbeats prove this
// session's hooks are live (hooksLive), a real death is detected in 20 min instead.
// A flat 45→20 cut would regress hook-less installs to 2× the false-idle rate.
const STALE_AFTER = 45 * 60_000;
const STALE_AFTER_HOOKED = 20 * 60_000;
// A task claimed 'in_progress' carries a lease. It must outlast the longest
// legitimate zero-ub-call engine run (45min is documented-normal), so the TTL is
// 3×STALE_AFTER: only a session that has been gone ~135min loses its claim. The
// lease is refreshed on every owner API call (heartbeat block) and at re-adoption.
const TASK_LEASE_MS = 3 * STALE_AFTER;
const leaseExpired = t => t.lease ? Date.parse(t.lease.expiresAt) < Date.now() : false;
function stampLease(st, task) {
  task.lease = { sessionId: st.control.session?.id || null, claimedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TASK_LEASE_MS).toISOString() };
}
setInterval(() => {
  for (const st of projects.values()) {
    // Reclaim orphaned in_progress tasks — INDEPENDENT of control state, so this also
    // heals tasks stranded by an explicit idle or a false quiescence. A leaseless
    // legacy in_progress with NO live session counts as expired (heals old exhibits).
    let tasksDirty = false;
    for (const t of st.tasks.tasks) {
      if (t.status !== 'in_progress' || t.deferred) continue; // never reclaim a paused-and-parked task
      const expired = t.lease ? leaseExpired(t) : !st.control.session;
      if (!expired) continue;
      t.status = 'ready';
      t.lease = null;
      t.reclaimed = true; // /api/next surfaces this as redelivered:true
      t.revision += 1;
      t.updatedAt = new Date().toISOString();
      t.activity.push({ ts: t.updatedAt, actor: 'system', action: 'reclaimed', detail: 'in_progress lease expired (session gone) — returned to ready for redelivery; subtasks/evidence preserved' });
      if (t.activity.length > 200) t.activity = t.activity.slice(-200);
      audit(st, 'system', 'task:reclaimed', { taskId: t.id });
      tasksDirty = true;
    }
    if (st._leaseDirty) { tasksDirty = true; st._leaseDirty = false; } // persist refreshed lease expiries
    // level-triggered invariant repair (prep orphans, dated retries, council surfacing,
    // SLA aging, stuck pause_requested) — idempotent + one-shot
    const rec = reconcile(st);
    if (rec.tasksDirty) tasksDirty = true;
    if (tasksDirty) touch(st, ['tasks'], 'tasks');
    if (rec.controlDirty) touch(st, ['control'], 'control');

    if (!st.control.session?.lastSeen) continue;
    // persist in-memory heartbeats so hooks (which read control.json from disk)
    // see fresh lastSeen — the GSD gate's staleness check depends on it
    if (st.control.session.lastSeen !== st._persistedLastSeen) {
      st._persistedLastSeen = st.control.session.lastSeen;
      saveProject(st, ['control']);
    }
    if (st.control.state !== 'running') continue;
    const idle = Date.now() - Date.parse(st.control.session.lastSeen);
    const staleWindow = st.control.hooksLive ? STALE_AFTER_HOOKED : STALE_AFTER;
    if (idle > staleWindow) {
      st.control.state = 'idle';
      audit(st, 'system', 'session:stale', { sessionId: st.control.session.id, idleMinutes: Math.round(idle / 60000) });
      st.control.session = null;
      touch(st, ['control'], 'control');
      log(`project ${st.id}: session went stale — marked idle`);
    }
  }
}, 60_000).unref();

// At-least-once directive delivery: a note is DELIVERED by /api/next (deliveredAt +
// deliveringSession) but only ACKNOWLEDGED (consumedAt) on the delivering session's
// NEXT authenticated call — so a lost response or a mid-delivery crash redelivers to
// the next session instead of vanishing. Mirrors the heartbeat sessionless carve-out.
function ackDeliveredNotes(st, sess, sessionless) {
  let changed = false;
  for (const d of st.control.directives) {
    if (d.type !== 'note' || d.consumedAt || !d.deliveredAt) continue;
    const mine = d.deliveringSession && (d.deliveringSession === sess
      || (sessionless && String(d.deliveringSession).startsWith('sess-')));
    if (mine) { d.consumedAt = new Date().toISOString(); changed = true; }
  }
  return changed;
}

// Level-triggered reconciler: a periodic sweep that repairs invariants which are
// otherwise only enforced at the moment an agent happens to act. Every rule is
// idempotent AND one-shot — it either falsifies its own trigger or stamps a marker —
// so a repaired condition is never re-fired every tick. Returns which stores changed.
function reconcile(st) {
  const now = Date.now();
  let tasksDirty = false, controlDirty = false;
  const controlIdle = st.control.state === 'idle' || !st.control.session;
  const note = (t, action, detail) => { t.activity.push({ ts: new Date().toISOString(), actor: 'system', action, detail }); if (t.activity.length > 200) t.activity = t.activity.slice(-200); };
  for (const t of st.tasks.tasks) {
    // (a) prep marked queued/running with no live prepare job — stranded; revert to inbox
    if (['queued', 'running'].includes(t.prep?.state)) {
      const live = st.jobs.jobs.some(j => j.type === 'prepare' && j.params?.taskId === t.id && ['queued', 'running'].includes(j.state));
      if (!live) {
        t.prep.state = 'failed';
        if (t.status === 'preparing') t.status = 'inbox';
        note(t, 'prep-orphaned', 'prep was queued/running with no live job — reverted so it is schedulable');
        audit(st, 'system', 'task:prep-orphaned', { taskId: t.id });
        tasksDirty = true;
      }
    }
    // (b) in_progress but the loop is idle/gone >30min — SURFACE (do not auto-reset;
    //     R7's lease reclaim owns resets). One-shot via orphanFlag.
    if (t.status === 'in_progress' && controlIdle && !t.deferred && !t.orphanFlag
      && now - Date.parse(t.updatedAt || t.createdAt) > 30 * 60_000) {
      t.orphanFlag = true;
      note(t, 'orphaned-in-progress', 'in_progress with no active loop >30min — surfaced for reconciliation');
      audit(st, 'system', 'task:orphaned-in-progress', { taskId: t.id });
      tasksDirty = true;
    }
    if (t.status !== 'in_progress' && t.orphanFlag) { t.orphanFlag = false; tasksDirty = true; }
    // (g) a dated defer (ub later --until/--days) that has come due — resurface it
    if (t.deferred && t.deferUntil && Date.parse(t.deferUntil) < now) {
      const was = t.deferUntil;
      t.deferred = false; t.deferUntil = null;
      note(t, 'resurfaced', `defer until ${was} elapsed — returned to the working queue`);
      audit(st, 'system', 'task:resurfaced', { taskId: t.id });
      tasksDirty = true;
    }
    // (c) a dated retry (ub block --retry-after) that has come due — return to ready
    if (t.blockedRetryAt && ['blocked', 'awaiting_operator'].includes(t.status) && Date.parse(t.blockedRetryAt) < now) {
      const was = t.blockedRetryAt;
      t.status = 'ready'; t.blockedReason = null; t.blockedRetryAt = null;
      note(t, 'auto-retry', `scheduled retry (${was}) elapsed — returned to ready`);
      audit(st, 'system', 'task:auto-retry', { taskId: t.id });
      tasksDirty = true;
    }
    // (d) a council that needs the operator but never changed the task status — surface it once
    const c = (t.councils || []).at(-1);
    if (c && c.synthesis?.needsOperator && !c.surfacedAt) {
      c.surfacedAt = new Date().toISOString();
      if (!['awaiting_operator', 'done', 'archived'].includes(t.status)) {
        t.status = 'awaiting_operator';
        t.blockedReason = t.blockedReason || ('Council needs your decision: ' + String(c.synthesis.decision || '').slice(0, 200));
      }
      note(t, 'council-surfaced', 'council synthesis flagged needsOperator');
      audit(st, 'system', 'task:council-surfaced', { taskId: t.id });
      tasksDirty = true;
    }
    // (e) SLA aging on operator-waiting tasks — badge tiers at 24h / 72h (stamp on transition only)
    if (['blocked', 'awaiting_operator', 'review'].includes(t.status)) {
      const age = now - Date.parse(t.updatedAt || t.createdAt);
      const tier = age > 72 * 3600_000 ? 72 : age > 24 * 3600_000 ? 24 : 0;
      if (tier && t.slaFlag !== tier) { t.slaFlag = tier; note(t, 'sla-flag', `waiting ${tier}h+`); tasksDirty = true; }
    } else if (t.slaFlag) { t.slaFlag = 0; tasksDirty = true; }
  }
  // (f) a pause_requested that never completed (session gone/stale >4h) — release to idle
  //     (never fabricate 'paused' — no checkpoint exists)
  if (st.control.state === 'pause_requested' && st.control.pauseRequestedAt
    && now - Date.parse(st.control.pauseRequestedAt) > 4 * 3600_000) {
    const sess = st.control.session;
    if (!sess || (sess.lastSeen && now - Date.parse(sess.lastSeen) > STALE_AFTER)) {
      st.control.state = 'idle'; st.control.session = null; st.control.pauseRequestedAt = null;
      audit(st, 'system', 'control:pause-expired', {});
      controlDirty = true;
    }
  }
  return { tasksDirty, controlDirty };
}

function broadcast(projectId, type, payload = {}) {
  const st = projects.get(projectId);
  if (st) st.tasks.seq = (st.tasks.seq || 0) + 1;
  const clients = sseClients.get(projectId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify({ type, seq: st?.tasks.seq, ...payload })}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch {} }
}

function touch(st, parts, eventType = 'refresh') {
  saveProject(st, parts);
  broadcast(st.id, eventType);
}

// ---------------------------------------------------------------- tokens
function loadOrCreateServerInfo(port) {
  const existing = readJson(SERVER_JSON, null);
  const info = {
    port, pid: process.pid, version: VERSION, startedAt: new Date().toISOString(),
    cliToken: existing?.cliToken || crypto.randomBytes(24).toString('hex'),
    uiToken: existing?.uiToken || crypto.randomBytes(24).toString('hex'),
  };
  atomicWrite(SERVER_JSON, info);
  return info;
}
let serverInfo = null;
const uiLaunchTickets = createLaunchTickets();
const browserSessions = new Map();

function issueBrowserSession() {
  const session = crypto.randomBytes(24).toString('hex');
  browserSessions.set(session, Date.now() + 8 * 60 * 60_000);
  return session;
}

function hasBrowserSession(session) {
  if (!session) return false;
  const expiresAt = browserSessions.get(session);
  if (!expiresAt || expiresAt <= Date.now()) { browserSessions.delete(session); return false; }
  return true;
}

function actorFor(req, url) {
  // Browser sessions use an HttpOnly cookie obtained from a short-lived, one-use
  // launch ticket. Secrets never travel in query parameters or bootstrap JSON.
  const tok = req.headers['x-ub-token'];
  if (tok && tok === serverInfo.cliToken) return 'claude';
  if (tok && tok === serverInfo.uiToken) return 'operator';
  if (hasBrowserSession(readCookie(req.headers.cookie, UI_COOKIE_NAME))) return 'operator';
  return null;
}

// ---------------------------------------------------------------- task helpers
const TASK_STATUSES = ['inbox', 'preparing', 'ready', 'in_progress', 'blocked', 'awaiting_operator', 'review', 'done', 'archived'];

// A pointer to an external canonical source (kind free-form: gsd/github/jira/doc; ref
// a caller-supplied stable id; url an optional deep link). Lets UB MIRROR an existing
// spine without owning it — and drives provenance-based dedupe so re-import is idempotent.
function normLinkedSource(ls) {
  if (!ls || typeof ls !== 'object' || !ls.ref) return null;
  return { kind: String(ls.kind || '').slice(0, 40), ref: String(ls.ref).slice(0, 200), url: String(ls.url || '').slice(0, 500) };
}
function linkedDedupeKey(ls) {
  const n = normLinkedSource(ls);
  return n ? crypto.createHash('sha256').update(`linked\0${n.kind}\0${n.ref}`).digest('hex').slice(0, 16) : null;
}

function newTask(input, actorKind, actorDetail) {
  const now = new Date().toISOString();
  return {
    id: newId('ub'),
    revision: 1,
    title: String(input.title || '').slice(0, 300),
    author: { kind: actorKind, detail: actorDetail || '' }, // immutable
    status: ['inbox', 'ready', 'blocked'].includes(input.status) ? input.status : 'inbox', // no task is born done/archived
    instructions: String(input.instructions || ''),
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.map(String) : [],
    subtasks: [],
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.map(String) : [],
    priority: Number(input.priority) >= 1 && Number(input.priority) <= 5 ? Number(input.priority) : 3,
    risk: ['low', 'medium', 'high'].includes(input.risk) ? input.risk : 'low',
    size: ['trivial', 'small', 'medium', 'large'].includes(input.size) ? input.size : 'small',
    engine: input.engine || 'auto',
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    prep: {
      auto: input.prep?.auto !== false,
      mode: ['full', 'quick', 'off'].includes(input.prep?.mode) ? input.prep.mode : (actorKind === 'operator' ? 'full' : 'quick'),
      directive: String(input.prep?.directive || ''),
      model: ['adaptive', 'haiku', 'sonnet', 'opus'].includes(input.prep?.model) ? input.prep.model : 'adaptive',
      state: 'none', plan: '', artifacts: [],
    },
    verification: { state: 'none', evidence: '', findings: [] },
    source: { context: String(input.source?.context || ''), sessionId: String(input.source?.sessionId || '') },
    linkedSource: normLinkedSource(input.linkedSource), // provenance pointer to an external canonical tracker (GSD/GitHub/doc); null when UB-native
    deferred: false, // "on ice" — kept out of the working loop until the operator reopens it
    blockedReason: null, archivedReason: null,
    activity: [{ ts: now, actor: actorKind, action: 'created', detail: input.source?.context || '' }],
    createdAt: now, updatedAt: now,
  };
}

const EDITABLE_FIELDS = ['title', 'instructions', 'acceptanceCriteria', 'dependsOn', 'priority', 'risk', 'size', 'engine', 'tags', 'status', 'blockedReason', 'subtasks', 'verification', 'deferred', 'blockedRetryAt', 'deferUntil', 'linkedSource'];
const ENGINE_VALUES = ['auto', 'gsd-fast', 'gsd-quick', 'gsd-execute-phase', 'gsd-debug', 'rigorous', 'rigorous-lite', 'direct'];

function validateField(k, v) {
  switch (k) {
    case 'title': { const s = String(v).trim().slice(0, 300); if (!s) throw httpErr(400, 'title cannot be empty'); return s; }
    case 'instructions': case 'blockedReason': return v === null ? null : String(v);
    case 'priority': { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 5) throw httpErr(400, 'priority must be 1-5'); return n; }
    case 'risk': if (!['low', 'medium', 'high'].includes(v)) throw httpErr(400, `invalid risk ${v}`); return v;
    case 'size': if (!['trivial', 'small', 'medium', 'large'].includes(v)) throw httpErr(400, `invalid size ${v}`); return v;
    case 'engine': if (!ENGINE_VALUES.includes(v)) throw httpErr(400, `invalid engine ${v}`); return v;
    case 'acceptanceCriteria': case 'tags': if (!Array.isArray(v)) throw httpErr(400, `${k} must be an array`); return v.map(x => String(x).slice(0, 500));
    case 'deferred': return v === true || v === 'true';
    case 'linkedSource': return v === null ? null : normLinkedSource(v);
    case 'blockedRetryAt': case 'deferUntil': { if (v === null || v === '') return null; const d = new Date(v); if (isNaN(d)) throw httpErr(400, `${k} must be an ISO timestamp or null`); return d.toISOString(); }
    default: return v;
  }
}

function findTask(st, id) { return st.tasks.tasks.find(t => t.id === id); }

// Idempotency: a bounded (500-key) dedupe cache on the tasks store. A retried or
// ambiguous `ub add` (timed-out but landed, offline-then-synced) presents the same
// dedupeKey and gets the original task back instead of creating a duplicate.
const DEDUPE_CAP = 500;
function dedupeLookup(st, key) {
  if (!key) return null;
  const hit = (st.tasks.dedupe || []).find(d => d.key === key);
  return hit ? findTask(st, hit.taskId) : null;
}
function dedupeRecord(st, key, taskId) {
  if (!key) return;
  st.tasks.dedupe = st.tasks.dedupe || [];
  st.tasks.dedupe.push({ key, taskId });
  if (st.tasks.dedupe.length > DEDUPE_CAP) st.tasks.dedupe = st.tasks.dedupe.slice(-DEDUPE_CAP);
}

// Single creation path shared by POST /api/tasks and the offline outbox ingest,
// so auto-prep, provenance, dedupe recording, and audit never diverge.
function createTaskFromInput(st, input, actor, dedupeKey) {
  const kind = actor === 'operator' ? 'operator' : (input.authorKind === 'operator' ? 'operator' : 'claude');
  const detail = input.authorDetail || (actor === 'operator' ? 'composer' : kind === 'operator' ? 'dictated to Claude' : 'main-session');
  const task = newTask(input, kind, detail);
  st.tasks.tasks.push(task);
  dedupeRecord(st, dedupeKey, task.id);
  log(`task:created author=${task.author.kind}/${task.author.detail} actor=${actor} title=${task.title.slice(0, 60)}`);
  audit(st, actor, 'task:created', { taskId: task.id, title: task.title, author: task.author });
  if (task.prep.auto && task.prep.mode !== 'off' && task.size !== 'trivial') {
    task.status = 'preparing';
    task.prep.state = 'queued';
    queueJob(st, 'prepare', { taskId: task.id }, actor);
  }
  return task;
}

function hasCycle(st, taskId, deps) {
  const graph = new Map(st.tasks.tasks.map(t => [t.id, t.id === taskId ? deps : t.dependsOn]));
  const seen = new Set(), stack = new Set();
  function visit(n) {
    if (stack.has(n)) return true;
    if (seen.has(n)) return false;
    seen.add(n); stack.add(n);
    for (const d of graph.get(n) || []) if (visit(d)) return true;
    stack.delete(n); return false;
  }
  return visit(taskId);
}

function applyPatch(st, task, patch, actor) {
  const changes = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE_FIELDS.includes(k) && k !== 'prep') continue;
    if (k === 'status') {
      if (!TASK_STATUSES.includes(v)) throw httpErr(400, `invalid status ${v}`);
      if (v === 'archived') {
        if (actor !== 'operator') throw httpErr(403, 'only the operator can archive tasks');
        task.archivedReason = String(patch.archivedReason || 'archived by operator');
      }
      // symmetric guard: only the operator may UN-archive (a stray claude edit or a
      // browser-defaulted status dropdown must not silently resurrect dropped work)
      if (task.status === 'archived' && v !== 'archived' && actor !== 'operator') throw httpErr(403, 'only the operator can un-archive a task');
      // leaving a blocked/awaiting state clears the now-stale reason (unless the patch
      // sets a fresh one) — the old text is preserved in activity, not left to render
      // a phantom "Reply & unblock" on a task that is no longer blocked
      if (['blocked', 'awaiting_operator'].includes(task.status) && !['blocked', 'awaiting_operator'].includes(v)
        && patch.blockedReason === undefined && task.blockedReason) {
        task.activity.push({ ts: new Date().toISOString(), actor, action: 'block-cleared', detail: `was blocked: ${String(task.blockedReason).slice(0, 200)}` });
        task.blockedReason = null;
      }
      const operatorOverride = actor === 'operator' && patch.operatorOverride === true;
      if (v === 'done' && !operatorOverride) {
        // structural gate — use EFFECTIVE values (patch key iteration order is not
        // guaranteed, so never rely on a sibling branch having run first)
        const evidence = patch.verification?.evidence ?? task.verification.evidence;
        if (!evidence || String(evidence).trim().length < 10) throw httpErr(422, 'done requires substantive verification.evidence (or operator override)');
        const effSubtasks = patch.subtasks !== undefined ? patch.subtasks : task.subtasks;
        // mirror the writer's normalization (:subtasks branch): anything not explicitly
        // done/skipped is stored as 'open', so a status-less subtask must count as open here
        const openSubs = (effSubtasks || []).filter(s => !['done', 'skipped'].includes(s.status));
        if (openSubs.length) throw httpErr(422, `done blocked: ${openSubs.length} open subtask(s) — finish or skip them first (ub subtask <id> <subId> done|skipped). Open: ${openSubs.map(s => s.id).join(', ')}`);
        const effVerState = patch.verification?.state ?? task.verification.state;
        if (effVerState === 'failed') throw httpErr(422, 'done blocked: verification.state is "failed" — record a passing verification, or use operator override');
      }
      // Reopening a done task for any ACTIVE status resets the verification gate:
      // re-closing then requires FRESH evidence (a recycled evidence string can't
      // silently re-close). done→archived is record-keeping and leaves it intact.
      const REOPEN_ACTIVE = ['inbox', 'preparing', 'ready', 'in_progress', 'blocked', 'awaiting_operator', 'review'];
      if (task.status === 'done' && REOPEN_ACTIVE.includes(v) && patch.verification === undefined) {
        task.evidenceHistory = [...(task.evidenceHistory || []), { ts: new Date().toISOString(), state: task.verification.state, evidence: task.verification.evidence }].slice(-10);
        task.verification = { state: 'none', evidence: '', findings: [] };
      }
      // Lease: claim on entering in_progress, release on leaving it. A dead session's
      // claim expires (TASK_LEASE_MS) and the 60s sweep returns the task to ready.
      if (v === 'in_progress') stampLease(st, task);
      else if (task.status === 'in_progress') { task.lease = null; task.reclaimed = false; }
      changes.push(`status ${task.status} → ${v}`);
      task[k] = v;
    } else if (k === 'prep') {
      for (const pk of ['auto', 'mode', 'directive', 'model']) if (v[pk] !== undefined) task.prep[pk] = v[pk];
      // plan/state may be written by the main session when it prepares a task itself
      // (fallback while headless sessions are unavailable, or for quick inline planning)
      if (v.plan !== undefined) {
        task.prep.plan = String(v.plan);
        task.prep.versions = [...(task.prep.versions || []), { ts: new Date().toISOString(), model: 'manual', mode: 'manual', plan: task.prep.plan }].slice(-5);
      }
      if (v.state !== undefined && ['none', 'ready', 'failed', 'stale'].includes(v.state)) task.prep.state = v.state;
      changes.push('prep settings');
    } else if (k === 'dependsOn') {
      const deps = (Array.isArray(v) ? v : []).map(String).filter(d => d !== task.id);
      for (const d of deps) if (!findTask(st, d)) throw httpErr(400, `unknown dependency ${d}`);
      if (hasCycle(st, task.id, deps)) throw httpErr(400, 'dependency cycle');
      task.dependsOn = deps; changes.push('dependencies');
    } else if (k === 'verification') {
      task.verification = { ...task.verification, ...v };
      changes.push('verification');
    } else if (k === 'subtasks') {
      task.subtasks = (Array.isArray(v) ? v : []).map((s, i) => ({
        id: typeof s.id === 'string' && /^st-[a-z0-9]{4,}$/.test(s.id) ? s.id : newId('st'),
        title: String(s.title || '').slice(0, 300), instructions: String(s.instructions || ''),
        status: ['open', 'done', 'skipped'].includes(s.status) ? s.status : 'open',
        author: String(s.author || actor).slice(0, 40), order: i,
      }));
      changes.push('subtasks');
    } else {
      task[k] = validateField(k, v); changes.push(k);
    }
  }
  if (changes.length) {
    task.revision += 1;
    task.updatedAt = new Date().toISOString();
    task.activity.push({ ts: task.updatedAt, actor, action: 'updated', detail: changes.join(', ') });
    if (task.activity.length > 200) task.activity = task.activity.slice(-200);
  }
  return changes;
}

// ---------------------------------------------------------------- scheduling
function eligibleTasks(st) {
  return st.tasks.tasks.filter(t => !t.deferred && ['inbox', 'preparing', 'ready', 'blocked'].includes(t.status));
}

function depsSatisfied(st, task) {
  return task.dependsOn.every(d => {
    const dep = findTask(st, d);
    return !dep || dep.status === 'done' || dep.status === 'archived';
  });
}

function validateSchedule(st, proposal, parallel) {
  if (!proposal || !Array.isArray(proposal.waves)) return { ok: false, reason: 'missing waves' };
  for (const k of Object.keys(proposal)) if (!['waves', 'warnings'].includes(k)) return { ok: false, reason: `unexpected field '${k}' in proposal` };
  for (const w of proposal.waves) {
    if (!w || typeof w !== 'object') return { ok: false, reason: 'malformed wave' };
    for (const k of Object.keys(w)) if (!['taskIds', 'rationale'].includes(k)) return { ok: false, reason: `unexpected field '${k}' in wave` };
  }
  const eligible = eligibleTasks(st).map(t => t.id);
  const seen = [];
  const waveIndex = new Map();
  proposal.waves.forEach((w, i) => {
    for (const tid of w.taskIds || []) { seen.push(tid); waveIndex.set(tid, i); }
  });
  const eligibleSet = new Set(eligible);
  if (seen.length !== new Set(seen).size) return { ok: false, reason: 'duplicate task ids in schedule' };
  for (const tid of seen) if (!eligibleSet.has(tid)) return { ok: false, reason: `unknown or ineligible task ${tid}` };
  for (const tid of eligible) if (!waveIndex.has(tid)) return { ok: false, reason: `task ${tid} missing from schedule` };
  if (!parallel && proposal.waves.some(w => (w.taskIds || []).length > 1)) return { ok: false, reason: 'parallel disabled but a wave has >1 task' };
  for (const t of eligibleTasks(st)) {
    for (const d of t.dependsOn) {
      if (waveIndex.has(d) && waveIndex.get(d) >= waveIndex.get(t.id)) {
        return { ok: false, reason: `dependency order violated: ${t.id} depends on ${d}` };
      }
    }
  }
  return { ok: true };
}

function applySchedule(st, sched) {
  if (st.schedule.active) {
    st.schedule.history.push(st.schedule.active);
    st.schedule.history = st.schedule.history.slice(-10);
  }
  st.schedule.active = { ...sched, appliedAt: new Date().toISOString() };
  st.schedule.pending = null;
}

function defaultOrder(st) {
  // no active schedule: priority desc, then createdAt asc
  return eligibleTasks(st)
    .slice()
    .sort((a, b) => (b.priority - a.priority) || a.createdAt.localeCompare(b.createdAt));
}

const RISK_RANK = { low: 0, medium: 1, high: 2 };
function pickNext(st) {
  // A bounded run (ub register/next --max-risk) caps which tasks the loop will pull,
  // so an operator can burn the safe lane overnight and leave fragile work for focused
  // /rigorous runs. Enforced ONLY here in runnable — never in eligibleTasks (which feeds
  // schedule validation/drift) — so scheduling invariants are untouched.
  const ceil = st.control.session?.maxRisk;
  const underCeiling = t => !ceil || RISK_RANK[t.risk] <= RISK_RANK[ceil];
  const runnable = t => !t.deferred && depsSatisfied(st, t) && ['ready', 'inbox'].includes(t.status) && !['queued', 'running'].includes(t.prep.state) && underCeiling(t);
  const sched = st.schedule.active;
  if (sched) {
    for (const wave of sched.waves) {
      const waveTasks = wave.taskIds.map(id => findTask(st, id)).filter(Boolean)
        .filter(t => !['done', 'archived'].includes(t.status));
      if (!waveTasks.length) continue;
      // only a lease-VALID in_progress holds the wave; an expired one is about to be
      // reclaimed by the sweep, so it must not deadlock the wave into eternal "waiting"
      const inProgress = waveTasks.filter(t => t.status === 'in_progress' && !leaseExpired(t));
      const candidates = waveTasks.filter(runnable);
      if (candidates.length) {
        return { task: candidates[0], wave: { id: wave.id, peers: waveTasks.filter(t => t !== candidates[0] && runnable(t)).map(t => t.id), parallel: !!sched.parallel } };
      }
      if (inProgress.length || waveTasks.some(t => ['preparing'].includes(t.status) || ['queued', 'running'].includes(t.prep.state))) {
        return { waiting: waveTasks.map(t => ({ id: t.id, status: t.status, prep: t.prep.state })) };
      }
      // wave contains only blocked/awaiting tasks -> fall through to next wave
    }
  }
  const ordered = defaultOrder(st).filter(runnable);
  if (ordered.length) return { task: ordered[0], wave: null };
  const pending = eligibleTasks(st).filter(t => ['queued', 'running'].includes(t.prep.state));
  if (pending.length) return { waiting: pending.map(t => ({ id: t.id, prep: t.prep.state })) };
  return {};
}

// Everything that means "the queue is NOT quiescent" — computed before honoring an
// idle request so a mistaken/injected/guest `ub idle` can't silently stop a loaded
// queue. Side-question ('question') jobs are documented non-blocking and excluded.
function idleBlockers(st) {
  const b = [];
  const inProg = st.tasks.tasks.filter(t => t.status === 'in_progress' && !t.deferred);
  if (inProg.length) b.push(`${inProg.length} task(s) in progress: ${inProg.slice(0, 3).map(t => `"${t.title}"`).join(', ')}`);
  const next = pickNext(st);
  if (next.task) b.push(`a runnable task is ready: "${next.task.title}"`);
  else if (next.waiting) b.push('preparation or peers are in flight');
  const review = st.tasks.tasks.filter(t => t.status === 'review');
  if (review.length) b.push(`${review.length} task(s) in review awaiting verification`);
  const directives = st.control.directives.filter(d => !d.consumedAt);
  if (directives.length) b.push(`${directives.length} unconsumed operator directive(s)`);
  const untriaged = st.candidates.items.filter(c => !c.dismissed && !c.promotedTaskId);
  if (untriaged.length) b.push(`${untriaged.length} captured signal(s) await triage`);
  const jobs = st.jobs.jobs.filter(j => ['queued', 'running'].includes(j.state) && j.type !== 'question');
  if (jobs.length) b.push(`${jobs.length} background job(s) active: ${[...new Set(jobs.map(j => j.type))].join(', ')}`);
  if (st.control.state === 'pause_requested') b.push('a pause was requested — run the pause procedure (ub paused), do not idle');
  return b;
}

// ---------------------------------------------------------------- headless session runner
function findClaudeCli() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@gsd-build', 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}
const CLAUDE_CLI = findClaudeCli();

const PROMPTS_DIR = path.join(__dirname, 'prompts');
function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8');
}

// Headless sessions authenticate independently of the Claude Desktop app (which
// blanks tokens in ~/.claude/.credentials.json and injects auth at runtime).
// UB keeps its own CLAUDE_CONFIG_DIR; the operator logs in once via `ub.mjs login`.
const UB_CLAUDE_CONFIG = path.join(ROOT, 'claude-config');
fs.mkdirSync(UB_CLAUDE_CONFIG, { recursive: true });
let headlessAuth = 'unknown'; // unknown | ok | required

function headlessEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(k)) continue; // don't leak this session's harness vars into children
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = UB_CLAUDE_CONFIG;
  env.CLAUDE_CODE_ENTRYPOINT = 'unfinished-business';
  const auth = readJson(path.join(ROOT, 'auth.json'), null);
  if (auth?.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = auth.oauthToken;
  return env;
}

const PREP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'string', description: 'Full execution plan in markdown: context, decisions (with council votes if any), step-by-step instructions detailed enough that execution requires almost no thinking, read-first files, verification steps.' },
    subtasks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, instructions: { type: 'string' } }, required: ['title', 'instructions'] } },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    engineRecommendation: { type: 'string', enum: ['gsd-fast', 'gsd-quick', 'gsd-execute-phase', 'gsd-debug', 'rigorous', 'rigorous-lite', 'direct'] },
    size: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    dependencies: { type: 'array', items: { type: 'string' }, description: 'titles or ids of queue tasks this depends on' },
    filesLikelyTouched: { type: 'array', items: { type: 'string' }, description: 'repo-relative paths execution will probably modify — used for parallel-safety checks' },
    risks: { type: 'array', items: { type: 'string' } },
    openQuestionsForOperator: { type: 'array', items: { type: 'string' } },
    deferUntil: { type: 'string', description: 'ISO date — set ONLY if the task cannot run until a specific wall-clock date / external event; the plan is still produced and runs when it clears' },
    deferReason: { type: 'string', description: 'one line: why it is date-gated (e.g. "waitlist opens 2026-07-17")' },
  },
  required: ['plan', 'subtasks', 'acceptanceCriteria', 'engineRecommendation', 'size', 'risk'],
};

const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    waves: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      taskIds: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
    }, required: ['taskIds', 'rationale'] } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['waves'],
};

let runningSessions = 0;

const QUESTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    answer: { type: 'string', description: 'Complete answer in markdown. Cite file paths and line numbers (e.g. src/foo.js:42) when referencing code.' },
    references: { type: 'array', items: { type: 'string' }, description: 'file paths or URLs cited' },
  },
  required: ['answer'],
};

const COUNCIL_ROLES = ['Pragmatist', 'Skeptic', 'Architect', 'Senior Engineer', 'Security Auditor', 'User Advocate', 'Reliability Engineer'];

const VOTE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    recommendation: { type: 'string' },
    strongestFor: { type: 'string' },
    strongestAgainst: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    notes: { type: 'string' },
  },
  required: ['recommendation', 'strongestFor', 'strongestAgainst', 'confidence'],
};

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    decision: { type: 'string' },
    rationale: { type: 'string' },
    dissent: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    needsOperator: { type: 'boolean' },
  },
  required: ['decision', 'rationale', 'dissent', 'confidence', 'needsOperator'],
};

function queueJob(st, type, params, actor) {
  const job = {
    id: newId('job'), type, params, state: 'queued', attempts: 0,
    createdAt: new Date().toISOString(), startedAt: null, endedAt: null, error: null, note: null,
  };
  st.jobs.jobs.push(job);
  if (st.jobs.jobs.length > 100) {
    // trim only terminal jobs — never drop a queued/running job from the persisted list
    const active = st.jobs.jobs.filter(j => ['queued', 'running'].includes(j.state));
    const terminal = st.jobs.jobs.filter(j => !['queued', 'running'].includes(j.state)).slice(-60);
    st.jobs.jobs = [...terminal, ...active].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  audit(st, actor, `job:${type}:queued`, params);
  touch(st, ['jobs']);
  pumpJobs(st);
  return job;
}

function pumpJobs(st) {
  if (st.degraded) return; // safe mode — do not run headless sessions against a frozen store
  for (const job of st.jobs.jobs) {
    if (runningSessions >= MAX_SESSIONS) break;
    if (job.state !== 'queued') continue;
    if (job.nextAttemptAt && Date.now() < job.nextAttemptAt) continue;
    runJob(st, job).catch(e => log('job crash', job.id, String(e)));
  }
}
setInterval(() => { for (const st of projects.values()) pumpJobs(st); }, 5000).unref();

function modelForJob(st, job) {
  if (job.type === 'order') return 'sonnet';
  if (job.type === 'question') {
    const q = st.questions.items.find(i => i.id === job.params.questionId);
    const m = q?.model || 'adaptive';
    return m !== 'adaptive' ? m : 'sonnet';
  }
  const task = findTask(st, job.params.taskId);
  const m = task?.prep.model || 'adaptive';
  if (m !== 'adaptive') return m;
  if (job.type === 'council') return 'opus'; // important decisions get the strongest members
  if (task && (task.size === 'large' || task.risk === 'high')) return 'opus';
  return 'sonnet';
}

// A prepare job that terminally fails (or whose CLI is missing) must never strand
// its task: status 'preparing' is unreachable by pickNext, so revert it to 'inbox'.
function failPrepTask(st, job, reason) {
  if (job.type !== 'prepare') return;
  const task = findTask(st, job.params.taskId);
  if (!task) return;
  task.prep.state = 'failed';
  if (task.status === 'preparing') task.status = 'inbox';
  task.activity.push({ ts: new Date().toISOString(), actor: 'planner', action: 'prep-failed', detail: String(reason).slice(0, 300) });
}

function failQuestion(st, job, reason) {
  if (job.type !== 'question') return;
  const q = st.questions.items.find(i => i.id === job.params.questionId);
  if (q) { q.state = 'failed'; q.error = String(reason).slice(0, 300); }
}

async function runJob(st, job) {
  if (!CLAUDE_CLI) {
    job.state = 'failed'; job.error = 'Claude CLI not found — headless sessions unavailable. Prep can be done by the main session instead.';
    failPrepTask(st, job, job.error);
    touch(st, ['tasks', 'jobs']); return;
  }
  job.state = 'running'; job.startedAt = new Date().toISOString(); job.attempts += 1;
  runningSessions += 1;
  let task = null;
  try {
    let prompt, schema, tools, allowed, timeout, effort, artDir;
    if (job.type === 'prepare') {
      task = findTask(st, job.params.taskId);
      if (!task) throw new Error('task disappeared');
      task.prep.state = 'running';
      job.taskRevision = task.revision;
      touch(st, ['tasks', 'jobs'], 'refresh');
      const mode = task.prep.mode === 'off' ? 'quick' : task.prep.mode;
      job.mode = mode; // used again in the result-application block below (different scope)
      const queueSnapshot = st.tasks.tasks
        .filter(t => !['done', 'archived'].includes(t.status))
        .map(t => ({ id: t.id, title: t.title, status: t.status }));
      const taskJson = JSON.stringify({
        id: task.id, title: task.title, instructions: task.instructions,
        acceptanceCriteria: task.acceptanceCriteria, priority: task.priority,
        risk: task.risk, size: task.size, engine: task.engine, source: task.source,
      }, null, 2);
      // function replacements: content containing $&, $', $$ must be inserted verbatim
      prompt = loadPrompt('prepare.md')
        .replaceAll('{{MODE}}', () => mode)
        .replaceAll('{{PROJECT_PATH}}', () => st.meta.path)
        .replaceAll('{{TASK_JSON}}', () => taskJson)
        .replaceAll('{{DIRECTIVE}}', () => task.prep.directive || '(none — use your judgment)')
        .replaceAll('{{QUEUE_SNAPSHOT}}', () => JSON.stringify(queueSnapshot, null, 2));
      schema = PREP_SCHEMA;
      tools = mode === 'full' ? 'Read,Glob,Grep,WebSearch,WebFetch,Agent,Task,TodoWrite' : 'Read,Glob,Grep';
      allowed = mode === 'full' ? ['WebSearch', 'WebFetch', 'Agent', 'Task'] : [];
      timeout = mode === 'full' ? JOB_TIMEOUTS.prepare_full : JOB_TIMEOUTS.prepare_quick;
      effort = mode === 'full' ? 'high' : 'medium';
      job.budget = mode === 'full' ? 10 : 4;
      artDir = path.join(st.dir, 'artifacts', task.id, job.id);
    } else if (job.type === 'order') {
      const snapshot = eligibleTasks(st).map(t => ({
        id: t.id, title: t.title, status: t.status, dependsOn: t.dependsOn,
        priority: t.priority, risk: t.risk, size: t.size, engine: t.engine,
        prepState: t.prep.state, filesLikelyTouched: t.prep.files || [],
        summary: (t.instructions || '').slice(0, 400),
      }));
      job.snapshotIds = snapshot.map(s => s.id).sort();
      if (!snapshot.length) throw new Error('no eligible tasks to order');
      prompt = loadPrompt('order.md')
        .replaceAll('{{PARALLEL}}', () => job.params.parallel ? 'ENABLED' : 'DISABLED')
        .replaceAll('{{TASKS_JSON}}', () => JSON.stringify(snapshot, null, 2));
      schema = ORDER_SCHEMA;
      tools = '';
      allowed = [];
      timeout = JOB_TIMEOUTS.order;
      effort = 'medium';
      job.budget = 2;
      artDir = path.join(st.dir, 'artifacts', '_schedule', job.id);
    } else if (job.type === 'question') {
      const q = st.questions.items.find(i => i.id === job.params.questionId);
      if (!q) throw new Error('question disappeared');
      q.state = 'running';
      touch(st, ['questions', 'jobs'], 'refresh');
      const queueSummary = st.tasks.tasks
        .filter(t => !['done', 'archived'].includes(t.status))
        .map(t => `- [${t.status}] ${t.title}`).join('\n');
      const qText = q.question;
      prompt = `You are a research assistant with full read-only access to the project at ${st.meta.path}.\n\n`
        + `Answer the question below thoroughly and concisely. When referencing code, cite specific file paths and line numbers (e.g. \`app/ub-server.mjs:42\`). Use the tools to explore and VERIFY — do not guess.\n\n`
        + `## Question\n\n${qText}\n\n`
        + `## Current queue (for situational context)\n\n${queueSummary || '(empty queue)'}\n\n`
        + `Use Read/Glob/Grep for the codebase, WebSearch/WebFetch for external facts, and Agent to spawn focused sub-investigations for complex questions.`;
      schema = QUESTION_SCHEMA;
      tools = 'Read,Glob,Grep,WebSearch,WebFetch,Agent';
      allowed = ['WebSearch', 'WebFetch', 'Agent'];
      timeout = 5 * 60_000;
      effort = 'high';
      job.budget = 3;
      artDir = path.join(st.dir, 'artifacts', '_questions', job.id);
    } else if (job.type === 'council') {
      return await runCouncilJob(st, job); // multi-session flow, handled separately
    } else throw new Error(`unknown job type ${job.type}`);

    fs.mkdirSync(artDir, { recursive: true });
    const model = modelForJob(st, job);
    job.model = model;
    touch(st, ['jobs']);

    const out = await runHeadless({ prompt, schema, tools, allowed, timeout, model, effort, budget: job.budget, cwd: st.meta.path, artDir });
    fs.writeFileSync(path.join(artDir, 'raw.json'), JSON.stringify(out.raw ?? out, null, 2));

    if (job.type === 'prepare') {
      const result = out.data;
      if (!result || typeof result.plan !== 'string' || !Array.isArray(result.subtasks)) {
        throw new Error('planner output failed shape validation (plan/subtasks missing)');
      }
      task = findTask(st, job.params.taskId);
      if (!task) throw new Error('task disappeared during prep');
      const stale = task.revision !== job.taskRevision;
      fs.writeFileSync(path.join(artDir, 'plan.md'), result.plan || '');
      task.prep.artifacts.push(path.relative(st.dir, path.join(artDir, 'plan.md')).replace(/\\/g, '/'));
      if (stale) {
        task.prep.state = 'stale';
        if (task.status === 'preparing') task.status = 'inbox'; // keep it schedulable
        task.activity.push({ ts: new Date().toISOString(), actor: 'planner', action: 'prep-stale', detail: 'task edited during preparation; plan stored but not applied' });
      } else {
        task.prep.state = 'ready';
        task.prep.plan = result.plan || '';
        if (Array.isArray(result.risks) && result.risks.length) {
          task.prep.plan += '\n\n## Risks\n' + result.risks.map(r => '- ' + String(r)).join('\n');
        }
        task.prep.versions = [...(task.prep.versions || []), { ts: new Date().toISOString(), model, mode: job.mode, plan: task.prep.plan }].slice(-5);
        if (Array.isArray(result.filesLikelyTouched)) task.prep.files = result.filesLikelyTouched.map(String).slice(0, 60);
        const existing = new Set(task.subtasks.map(s => s.title.toLowerCase()));
        for (const s of result.subtasks || []) {
          if (existing.has(String(s.title).toLowerCase())) continue;
          task.subtasks.push({ id: newId('st'), title: String(s.title).slice(0, 300), instructions: String(s.instructions || ''), status: 'open', author: 'planner', order: task.subtasks.length });
        }
        const critSet = new Set(task.acceptanceCriteria.map(c => c.toLowerCase()));
        for (const c of result.acceptanceCriteria || []) if (!critSet.has(String(c).toLowerCase())) task.acceptanceCriteria.push(String(c));
        if (task.engine === 'auto' && ENGINE_VALUES.includes(result.engineRecommendation)) task.engine = result.engineRecommendation;
        if (['trivial', 'small', 'medium', 'large'].includes(result.size)) task.size = result.size;
        if (['low', 'medium', 'high'].includes(result.risk)) task.risk = result.risk;
        for (const d of result.dependencies || []) {
          const dep = st.tasks.tasks.find(t => t.id === d || t.title.toLowerCase() === String(d).toLowerCase());
          if (!dep || dep.id === task.id || task.dependsOn.includes(dep.id) || ['done', 'archived'].includes(dep.status)) continue;
          const nd = [...task.dependsOn, dep.id];
          if (!hasCycle(st, task.id, nd)) task.dependsOn = nd;
        }
        if (task.status === 'inbox' || task.status === 'preparing') { task.status = 'ready'; task.blockedReason = null; } // don't carry a stale block into ready (bypasses applyPatch)
        if (result.openQuestionsForOperator?.length) {
          task.status = 'awaiting_operator';
          task.blockedReason = 'Planner has questions:\n- ' + result.openQuestionsForOperator.join('\n- ');
        }
        // the planner may find the task is date-gated (can't run until a wall-clock date):
        // park it as a dated defer — the reconciler auto-returns it when due, plan intact
        const du = result.deferUntil && new Date(result.deferUntil);
        if (du && !isNaN(du) && du.getTime() > Date.now()) {
          task.deferred = true;
          task.deferUntil = du.toISOString();
          task.activity.push({ ts: new Date().toISOString(), actor: 'planner', action: 'prep-deferred', detail: `date-gated until ${task.deferUntil}${result.deferReason ? ` — ${String(result.deferReason).slice(0, 200)}` : ''}` });
        }
        task.revision += 1;
        task.updatedAt = new Date().toISOString();
        task.activity.push({ ts: task.updatedAt, actor: 'planner', action: 'prepared', detail: `model ${model}; ${result.subtasks?.length || 0} subtasks proposed` });
      }
      audit(st, 'planner', 'task:prepared', { taskId: task.id, jobId: job.id, stale });
    } else if (job.type === 'order') {
      const proposal = out.data;
      const currentIds = eligibleTasks(st).map(t => t.id).sort();
      if (JSON.stringify(currentIds) !== JSON.stringify(job.snapshotIds)) throw new Error('queue changed while ordering — retry');
      const check = validateSchedule(st, proposal, job.params.parallel);
      if (!check.ok) throw new Error(`orderer proposal rejected: ${check.reason}`);
      const sched = {
        id: newId('sched'), parallel: !!job.params.parallel,
        waves: proposal.waves.map((w, i) => ({ id: `wave-${i + 1}`, taskIds: w.taskIds, rationale: String(w.rationale || '') })),
        warnings: (proposal.warnings || []).map(String),
        generatedBy: { jobId: job.id, model: job.model }, createdAt: new Date().toISOString(),
      };
      if (st.control.settings.autoApplySchedule) {
        applySchedule(st, sched);
        audit(st, 'orderer', 'schedule:applied', { jobId: job.id, waves: sched.waves.length });
      } else {
        st.schedule.pending = sched;
        audit(st, 'orderer', 'schedule:proposed', { jobId: job.id, waves: sched.waves.length });
      }
    } else if (job.type === 'question') {
      const q = st.questions.items.find(i => i.id === job.params.questionId);
      if (q) {
        q.state = 'done';
        q.answer = String(out.data.answer || '');
        q.references = Array.isArray(out.data.references) ? out.data.references.map(String) : [];
        q.answeredAt = new Date().toISOString();
      }
      audit(st, 'system', 'question:answered', { questionId: job.params.questionId, jobId: job.id });
    }
    job.state = 'done'; job.endedAt = new Date().toISOString();
    touch(st, job.type === 'question' ? ['questions', 'jobs'] : ['tasks', 'schedule', 'jobs']);
  } catch (e) {
    job.error = String(e.message || e);
    log('job failed', job.id, job.type, job.error);
    if (e.authRequired) job.attempts = JOB_RETRIES + 1; // retrying cannot fix a missing login
    if (job.attempts <= JOB_RETRIES) {
      job.state = 'queued';
      job.nextAttemptAt = Date.now() + RETRY_BACKOFF_MS[Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
      job.note = `retry ${job.attempts}/${JOB_RETRIES} after error: ${job.error}`;
    } else {
      job.state = 'failed'; job.endedAt = new Date().toISOString();
      failPrepTask(st, job, job.error);
      failQuestion(st, job, job.error);
      audit(st, 'system', `job:${job.type}:failed`, { jobId: job.id, error: job.error });
    }
    touch(st, job.type === 'question' ? ['questions', 'jobs'] : ['tasks', 'jobs']);
  } finally {
    runningSessions -= 1;
    pumpJobs(st);
  }
}

// Council: N independent votes (waves of ≤2, borrowing a second semaphore slot
// only when globally free) + one synthesis. Dissent is preserved verbatim.
async function runCouncilJob(st, job) {
  const task = findTask(st, job.params.taskId);
  if (!task) throw new Error('task disappeared');
  const n = job.params.n;
  const roles = COUNCIL_ROLES.slice(0, n);
  const model = modelForJob(st, job);
  job.model = model;
  touch(st, ['jobs']);
  const baseDir = path.join(st.dir, 'artifacts', task.id, job.id);
  const taskJson = JSON.stringify({ id: task.id, title: task.title, instructions: task.instructions, plan: task.prep.plan?.slice(0, 4000) || '', size: task.size, risk: task.risk }, null, 2);
  const optionsBlock = job.params.options?.length
    ? 'Options under consideration (you may argue for an unlisted better option):\n' + job.params.options.map((o, i) => `${i + 1}. ${o}`).join('\n')
    : 'No fixed option list — identify the realistic options yourself before recommending.';

  async function vote(role, idx) {
    const artDir = path.join(baseDir, `vote-${idx + 1}`);
    fs.mkdirSync(artDir, { recursive: true });
    const prompt = loadPrompt('council-vote.md')
      .replaceAll('{{ROLE}}', () => role)
      .replaceAll('{{PROJECT_PATH}}', () => st.meta.path)
      .replaceAll('{{QUESTION}}', () => job.params.question)
      .replaceAll('{{TASK_JSON}}', () => taskJson)
      .replaceAll('{{OPTIONS_BLOCK}}', () => optionsBlock);
    const out = await runHeadless({ prompt, schema: VOTE_SCHEMA, tools: 'Read,Glob,Grep', allowed: [], timeout: 8 * 60_000, model, effort: 'high', budget: 3, cwd: st.meta.path, artDir });
    fs.writeFileSync(path.join(artDir, 'vote.json'), JSON.stringify(out.data, null, 2));
    return { role, ...out.data };
  }

  const votes = [];
  const failures = [];
  for (let i = 0; i < roles.length;) {
    const batch = [vote(roles[i], i).catch(e => { failures.push({ role: roles[i], error: String(e.message) }); if (e.authRequired) throw e; return null; })];
    i++;
    if (i < roles.length && runningSessions < MAX_SESSIONS) {
      runningSessions++;
      const j = i;
      batch.push(vote(roles[j], j).catch(e => { failures.push({ role: roles[j], error: String(e.message) }); if (e.authRequired) throw e; return null; }).finally(() => { runningSessions--; }));
      i++;
    }
    for (const v of await Promise.all(batch)) if (v) votes.push(v);
  }
  if (votes.length < Math.ceil(n / 2)) { // majority quorum: 2/3, 3/5, 4/7
    throw new Error(`council quorum failed: only ${votes.length}/${n} votes returned (${failures.map(f => f.role + ': ' + f.error.slice(0, 80)).join('; ')})`);
  }

  const synthDir = path.join(baseDir, 'synthesis');
  fs.mkdirSync(synthDir, { recursive: true });
  const synthPrompt = loadPrompt('council-synthesis.md')
    .replaceAll('{{N}}', () => String(votes.length))
    .replaceAll('{{QUESTION}}', () => job.params.question)
    .replaceAll('{{VOTES_JSON}}', () => JSON.stringify(votes, null, 2));
  const synth = await runHeadless({ prompt: synthPrompt, schema: SYNTH_SCHEMA, tools: '', allowed: [], timeout: 6 * 60_000, model, effort: 'high', budget: 3, cwd: st.meta.path, artDir: synthDir });
  fs.writeFileSync(path.join(synthDir, 'synthesis.json'), JSON.stringify(synth.data, null, 2));

  const fresh = findTask(st, job.params.taskId);
  if (!fresh) throw new Error('task disappeared during council');
  fresh.councils = fresh.councils || [];
  if (fresh.councils.some(c => c.jobId === job.id)) { job.state = 'done'; job.endedAt = new Date().toISOString(); touch(st, ['jobs']); return; } // retry after persist failure — don't duplicate
  fresh.councils.push({
    id: newId('council'), jobId: job.id, question: job.params.question, options: job.params.options || [],
    model, votes, missingVotes: failures, synthesis: synth.data, createdAt: new Date().toISOString(),
  });
  fresh.activity.push({ ts: new Date().toISOString(), actor: 'council', action: 'council-decided', detail: `${votes.length}/${n} votes · ${synth.data.needsOperator ? 'NEEDS OPERATOR' : 'decided'}: ${String(synth.data.decision).slice(0, 140)}` });
  audit(st, 'council', 'council:decided', { taskId: fresh.id, jobId: job.id, needsOperator: synth.data.needsOperator, confidence: synth.data.confidence });
  job.state = 'done'; job.endedAt = new Date().toISOString();
  touch(st, ['tasks', 'jobs']);
}

function runHeadless({ prompt, schema, tools, allowed, timeout, model, effort, budget, cwd, artDir }) {
  return new Promise((resolve, reject) => {
    // fallback must differ from the main model (the CLI rejects it otherwise)
    const fallback = model === 'opus' ? 'sonnet' : model === 'sonnet' ? 'haiku' : null;
    const args = [CLAUDE_CLI, '-p', '--output-format', 'json', '--model', model, '--effort', effort,
      '--no-session-persistence',
      '--disallowedTools', 'Bash,Write,Edit,NotebookEdit'];
    if (fallback) args.push('--fallback-model', fallback);
    if (budget) args.push('--max-budget-usd', String(budget));
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (tools !== undefined) args.push('--tools', tools === '' ? '' : tools);
    if (allowed?.length) args.push('--allowedTools', allowed.join(','));
    const child = spawn(process.execPath, args, {
      cwd: fs.existsSync(cwd) ? cwd : ROOT,
      env: headlessEnv(),
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.on('error', () => {}); // EPIPE from a fast-exiting child must not kill the server
    child.stdin.write(prompt, () => {});
    child.stdin.end();
    const killer = setTimeout(() => {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    }, timeout);
    const authFailure = text => /Not logged in|Please run \/login/i.test(text);
    const authReject = () => {
      headlessAuth = 'required';
      const err = new Error('AUTH_REQUIRED: headless planning sessions need a one-time login — run: node "' + path.join(__dirname, 'ub.mjs') + '" login');
      err.authRequired = true;
      reject(err);
    };
    child.on('close', code => {
      clearTimeout(killer);
      try { fs.writeFileSync(path.join(artDir, 'log.txt'), `exit ${code}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout.slice(0, 200_000)}`); } catch {}
      try {
        const raw = JSON.parse(stdout);
        if (raw.is_error) return authFailure(String(raw.result)) ? authReject() : reject(new Error(`headless session error: ${String(raw.result).slice(0, 300)}`));
        if (code !== 0) return reject(new Error(`headless session exit ${code}: ${(stderr || stdout).slice(0, 400)}`));
        headlessAuth = 'ok';
        let data = raw.structured_output ?? raw.result ?? raw;
        if (typeof data === 'string') {
          const m = data.match(/\{[\s\S]*\}/);
          data = JSON.parse(m ? m[0] : data);
        }
        resolve({ data, raw });
      } catch {
        // stdout was not JSON — classify by exit state
        if (authFailure(stdout + stderr)) return authReject();
        if (code !== 0) return reject(new Error(`headless session exit ${code}: ${(stderr || stdout).slice(0, 400)}`));
        reject(new Error(`could not parse headless session output: ${stdout.slice(0, 200)}`));
      }
    });
    child.on('error', e => { clearTimeout(killer); reject(e); });
  });
}

// ---------------------------------------------------------------- HTTP layer
function httpErr(code, message, extra) { const e = new Error(message); e.statusCode = code; if (extra) e.body = extra; return e; }

// Loop ownership: the write path that DRIVES the loop (claim/complete a task, pull
// the next task, pause/idle the loop) is reserved for the registered owning session.
// Capture, reads, and every operator call stay open. Mirrors the heartbeat match:
// owner iff the session header equals the stored id, OR (for a sess- fallback owner
// whose CLI can't send the header) no header is present.
function isOwner(st, req) {
  const cur = st.control.session;
  if (!cur) return true; // no active owner — the first caller may claim it
  const sess = req.headers['x-ub-session'];
  return sess ? sess === cur.id : String(cur.id).startsWith('sess-');
}
function requireOwner(st, req, actor) {
  if (actor === 'operator') return;        // the operator is never a guest
  if (!st.control.session) return;          // no owner to defer to
  if (!isOwner(st, req)) throw httpErr(403, 'another session owns the work loop', { role: 'guest', hint: 'capture-only — ub add / ub list / ub status are allowed; do not run the loop, pause, or idle' });
}

function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 5_000_000) throw httpErr(413, 'body too large'); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw httpErr(400, 'invalid JSON body'); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };

function getProject(query) {
  const id = query.get('project');
  const st = id && loadProject(id);
  if (!st) throw httpErr(404, 'unknown project — register it first (ub.mjs ensure)');
  return st;
}

// Whether UB's core guard hooks are installed in the user's Claude settings. The
// server reads the same machine-local file the CLI writes; cached 30s so a chatty
// UI (state fetched on every SSE event) does not re-read it constantly.
let _hooksInstalledCache = { at: 0, val: false };
function hooksInstalled() {
  if (Date.now() - _hooksInstalledCache.at < 30_000) return _hooksInstalledCache.val;
  let val = false;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const isOurs = g => (g.hooks || []).some(h => /unfinished[ -]business/i.test(String(h.command || '')) && String(h.command || '').includes('hooks.mjs'));
    val = ['Stop', 'SessionStart'].every(e => (s.hooks?.[e] || []).some(isOurs)); // the enforcement-critical pair
  } catch {}
  _hooksInstalledCache = { at: Date.now(), val };
  return val;
}

function stateSnapshot(st) {
  const cands = st.candidates.items.filter(c => !c.dismissed && !c.promotedTaskId);
  return {
    project: st.meta,
    control: { state: st.control.state, session: st.control.session, pausedInfo: st.control.pausedInfo, settings: st.control.settings,
      pendingDirectives: st.control.directives.filter(d => !d.consumedAt).length,
      directives: st.control.directives.filter(d => !d.consumedAt).map(d => ({ id: d.id, text: d.payload, createdAt: d.createdAt, delivered: !!d.deliveredAt })),
      resumePending: !!st.control.resumePending, pausedHistory: (st.control.pausedHistory || []).slice(-5) },
    tasks: st.tasks.tasks, seq: st.tasks.seq,
    schedule: st.schedule.active, pendingSchedule: st.schedule.pending || null, scheduleHistory: st.schedule.history.length,
    jobs: st.jobs.jobs.slice(-20).reverse(),
    candidates: { count: cands.length, items: cands.slice(-50).reverse(), archivedUnseen: st.control.candidateArchive?.unseen || 0, archivedTotal: st.control.candidateArchive?.total || 0 },
    questions: st.questions.items.slice(-20).reverse(),
    server: { version: VERSION, claudeCli: !!CLAUDE_CLI, headlessAuth, runningSessions, maxSessions: MAX_SESSIONS, hooksInstalled: hooksInstalled(), loginCommand: `node "${path.join(__dirname, 'ub.mjs')}" login` },
    degraded: !!st.degraded, auditBroken: !!st.auditBroken,
  };
}

const routes = {
  'GET /api/health': (req, res) => send(res, 200, { ok: true, version: VERSION, pid: process.pid, claudeCli: !!CLAUDE_CLI }),

  // GET is authenticated and intentionally returns only public display metadata.
  // It never returns the operator token or on-disk project paths.
  'GET /api/bootstrap': (req, res) => send(res, 200, { version: VERSION, projects: publicProjects(registry.projects) }),

  // The CLI/MCP (authenticated with the CLI token) mints a short-lived URL-fragment
  // ticket. A fragment is not sent in HTTP requests or Referer headers.
  'POST /api/ui-launch': (req, res, q, body, actor) => {
    if (actor !== 'claude') throw httpErr(403, 'only the local CLI may mint a UI launch ticket');
    const st = getProject(q);
    send(res, 200, uiLaunchTickets.mint(st.id));
  },

  // Exchange a one-use launch ticket for an HttpOnly, same-site browser session.
  // Return only the project bound to that ticket, with its path removed.
  'POST /api/bootstrap': (req, res, q, body) => {
    const ticket = uiLaunchTickets.consume(body.nonce);
    if (!ticket) throw httpErr(401, 'invalid or expired UI launch ticket — run `ub ensure` for a fresh URL');
    const visible = publicProjects(registry.projects, ticket.projectId);
    if (!visible.length) throw httpErr(404, 'launch project no longer exists');
    const browserSession = issueBrowserSession();
    send(res, 200, { version: VERSION, projects: visible }, {
      'Set-Cookie': `${UI_COOKIE_NAME}=${browserSession}; HttpOnly; SameSite=Strict; Path=/`,
    });
  },

  'POST /api/projects': async (req, res, q, body, actor) => {
    const p = body.path;
    if (!p || !fs.existsSync(p)) throw httpErr(400, `project path does not exist: ${p}`);
    const id = projectIdFor(p);
    let meta = registry.projects.find(x => x.id === id);
    const isNew = !meta;
    if (isNew) {
      meta = { id, path: path.resolve(p), name: body.name || path.basename(path.resolve(p)), createdAt: new Date().toISOString() };
      registry.projects.push(meta);
      atomicWrite(REGISTRY_JSON, registry);
      fs.mkdirSync(projectDir(id), { recursive: true });
    }
    const st = loadProject(id);
    if (isNew) audit(st, actor, 'project:registered', { path: meta.path });
    send(res, 200, { project: meta });
  },

  'GET /api/state': (req, res, q) => send(res, 200, stateSnapshot(getProject(q))),

  'GET /api/events': (req, res, q) => {
    const st = getProject(q);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', seq: st.tasks.seq })}\n\n`);
    if (!sseClients.has(st.id)) sseClients.set(st.id, new Set());
    sseClients.get(st.id).add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
    req.on('close', () => { clearInterval(ping); sseClients.get(st.id)?.delete(res); });
  },

  'POST /api/tasks': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (!body.title) throw httpErr(400, 'title required');
    // capture must survive SAFE MODE — spool it to the outbox (which skips degraded
    // projects until recovery) instead of mutating the frozen store. Capture never breaks.
    if (st.degraded) {
      spoolTaskServerSide(st, body);
      return send(res, 202, { spooled: true, note: 'project in safe mode — task captured to the durable outbox; it will sync when the operator recovers the store' });
    }
    // idempotency: a linked import dedupes on (kind,ref) so re-import returns the
    // original (never a 409 — capture must not fail); otherwise on the client key
    const dedupeKey = linkedDedupeKey(body.linkedSource) || body.dedupeKey;
    const dup = dedupeLookup(st, dedupeKey);
    if (dup) return send(res, 200, { task: dup, duplicate: true });
    const task = createTaskFromInput(st, body, actor, dedupeKey);
    touch(st, ['tasks'], 'task-created');
    send(res, 200, { task });
  },

  'PATCH /api/tasks': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const idx = st.tasks.tasks.findIndex(t => t.id === q.get('id'));
    if (idx < 0) throw httpErr(404, 'task not found');
    const orig = st.tasks.tasks[idx];
    if (body.expectedRevision !== undefined && body.expectedRevision !== orig.revision) {
      throw httpErr(409, `revision conflict: task is at r${orig.revision}, you expected r${body.expectedRevision}`);
    }
    if (body.patch?.author) throw httpErr(403, 'author is immutable');
    // claiming or completing a task drives the loop — reserve it for the owner
    if (['in_progress', 'done'].includes(body.patch?.status)) requireOwner(st, req, actor);
    // apply to a clone so a mid-patch validation error cannot leave a half-mutated task
    const work = structuredClone(orig);
    const changes = applyPatch(st, work, body.patch || {}, actor);
    st.tasks.tasks[idx] = work;
    audit(st, actor, 'task:updated', { taskId: work.id, changes });
    touch(st, ['tasks']);
    // warn when snoozing a task strands ready dependents (otherwise invisible)
    let strandWarning;
    if (work.deferred && body.patch?.deferred === true) {
      const deps = st.tasks.tasks.filter(t => !['done', 'archived'].includes(t.status) && t.dependsOn.includes(work.id));
      if (deps.length) strandWarning = `snoozing this strands ${deps.length} task(s) that depend on it: ${deps.slice(0, 3).map(t => t.title).join(', ')}`;
    }
    send(res, 200, { task: work, ...(strandWarning ? { strandWarning } : {}) });
  },

  'POST /api/tasks/prepare': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const task = findTask(st, body.taskId);
    if (!task) throw httpErr(404, 'task not found');
    if (['queued', 'running'].includes(task.prep.state)) throw httpErr(409, 'prep already in progress');
    if (body.directive !== undefined) task.prep.directive = String(body.directive);
    if (body.model) task.prep.model = body.model;
    if (body.mode) task.prep.mode = body.mode;
    task.prep.state = 'queued';
    if (task.status === 'inbox') task.status = 'preparing';
    const job = queueJob(st, 'prepare', { taskId: task.id }, actor);
    touch(st, ['tasks']);
    send(res, 200, { job });
  },

  'POST /api/tasks/council': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const task = findTask(st, body.taskId);
    if (!task) throw httpErr(404, 'task not found');
    const question = String(body.question || '').trim().slice(0, 2000);
    if (!question) throw httpErr(400, 'question required');
    if (body.n !== undefined && ![3, 5, 7].includes(Number(body.n))) throw httpErr(400, 'n must be 3, 5, or 7');
    const n = Number(body.n) || 5;
    const options = Array.isArray(body.options) ? body.options.map(o => String(o).slice(0, 400)).slice(0, 8) : [];
    const job = queueJob(st, 'council', { taskId: task.id, question, options, n }, actor);
    send(res, 200, { job });
  },

  'POST /api/questions': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (!CLAUDE_CLI) throw httpErr(503, 'Claude CLI not found — side questions need headless sessions');
    const text = String(body.question || '').trim().slice(0, 4000);
    if (!text) throw httpErr(400, 'question required');
    const model = ['adaptive', 'haiku', 'sonnet', 'opus'].includes(body.model) ? body.model : 'adaptive';
    const item = {
      id: newId('q'), question: text, model, state: 'queued',
      answer: '', references: [], error: null, jobId: null,
      createdAt: new Date().toISOString(), answeredAt: null,
      askedBy: actor === 'operator' ? 'operator' : 'claude',
    };
    st.questions.items.push(item);
    trimQuestions(st);
    const job = queueJob(st, 'question', { questionId: item.id }, actor);
    item.jobId = job.id;
    audit(st, actor, 'question:asked', { questionId: item.id, question: text.slice(0, 200) });
    touch(st, ['questions']);
    send(res, 200, { question: item, job });
  },

  'POST /api/jobs/order': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (st.jobs.jobs.some(j => j.type === 'order' && ['queued', 'running'].includes(j.state))) throw httpErr(409, 'an ordering job is already in progress');
    const job = queueJob(st, 'order', { parallel: !!body.parallel }, actor);
    send(res, 200, { job });
  },

  // Manual drag-and-drop order from the UI: single-task waves in the given order
  // (remaining eligible tasks keep their relative order at the end).
  'POST /api/schedule/manual': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const taskIds = body.taskIds;
    if (!Array.isArray(taskIds) || !taskIds.length) throw httpErr(400, 'taskIds array required');
    const eligible = eligibleTasks(st).map(t => t.id);
    const eligibleSet = new Set(eligible);
    const seen = new Set();
    for (const id of taskIds) {
      if (!eligibleSet.has(id)) throw httpErr(400, `task ${id} is not eligible for scheduling`);
      if (seen.has(id)) throw httpErr(400, `duplicate task ${id}`);
      seen.add(id);
    }
    const ordered = [...taskIds, ...eligible.filter(id => !seen.has(id))];
    const sched = {
      id: newId('sched'), parallel: false,
      waves: ordered.map((id, i) => ({ id: `wave-${i + 1}`, taskIds: [id], rationale: i === 0 ? 'manual order (drag-and-drop)' : '' })),
      warnings: [], generatedBy: { manual: true, by: actor }, createdAt: new Date().toISOString(),
    };
    applySchedule(st, sched);
    audit(st, actor, 'schedule:manual', { count: ordered.length });
    touch(st, ['schedule']);
    send(res, 200, { schedule: st.schedule.active });
  },

  'POST /api/schedule/apply': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const pending = st.schedule.pending;
    if (!pending) throw httpErr(404, 'no pending schedule proposal');
    // revalidate — the queue may have changed since the proposal was generated
    const check = validateSchedule(st, { waves: pending.waves.map(w => ({ taskIds: w.taskIds, rationale: w.rationale })), warnings: pending.warnings }, pending.parallel);
    if (!check.ok) {
      st.schedule.pending = null;
      audit(st, actor, 'schedule:pending-rejected', { reason: check.reason });
      touch(st, ['schedule']);
      throw httpErr(409, `proposal is stale — ${check.reason}. Re-run Optimize order.`);
    }
    applySchedule(st, pending);
    audit(st, actor, 'schedule:applied', { scheduleId: st.schedule.active.id, from: 'pending' });
    touch(st, ['schedule']);
    send(res, 200, { schedule: st.schedule.active });
  },

  'POST /api/schedule/discard': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (!st.schedule.pending) throw httpErr(404, 'no pending schedule proposal');
    st.schedule.pending = null;
    audit(st, actor, 'schedule:discarded', {});
    touch(st, ['schedule']);
    send(res, 200, {});
  },

  'POST /api/schedule/undo': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (!st.schedule.history.length) throw httpErr(400, 'nothing to undo');
    st.schedule.active = st.schedule.history.pop();
    audit(st, actor, 'schedule:undo', {});
    touch(st, ['schedule']);
    send(res, 200, { schedule: st.schedule.active });
  },

  'POST /api/schedule/clear': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (st.schedule.active) st.schedule.history.push(st.schedule.active);
    st.schedule.active = null;
    audit(st, actor, 'schedule:cleared', {});
    touch(st, ['schedule']);
    send(res, 200, {});
  },

  'POST /api/candidates/promote': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const cand = st.candidates.items.find(c => c.id === body.id);
    if (!cand) throw httpErr(404, 'candidate not found');
    if (cand.promotedTaskId) throw httpErr(409, 'already promoted');
    const task = newTask({
      title: String(body.title || cand.summary.split('\n')[0]).slice(0, 300),
      instructions: String(body.instructions || cand.summary),
      prep: { auto: false, mode: 'off' },
      source: { context: `hook capture (${cand.kind}) at ${cand.ts}`, sessionId: cand.sessionId },
    }, actor === 'operator' ? 'operator' : 'claude', 'hook-capture');
    st.tasks.tasks.push(task);
    cand.promotedTaskId = task.id;
    audit(st, actor, 'candidate:promoted', { candidateId: cand.id, taskId: task.id });
    touch(st, ['tasks', 'candidates'], 'task-created');
    send(res, 200, { task });
  },

  'POST /api/candidates/dismiss': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const cand = st.candidates.items.find(c => c.id === body.id);
    if (!cand) throw httpErr(404, 'candidate not found');
    cand.dismissed = { at: new Date().toISOString(), by: actor, reason: String(body.reason || '') };
    audit(st, actor, 'candidate:dismissed', { candidateId: cand.id });
    touch(st, ['candidates'], 'candidates');
    send(res, 200, {});
  },

  // Undo a dismissal while the candidate is still in the live list (an accidental
  // click beside "Make task" must be recoverable).
  'POST /api/candidates/undismiss': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const cand = st.candidates.items.find(c => c.id === body.id);
    if (!cand) throw httpErr(404, 'candidate not found — it may have aged out; see the archive');
    cand.dismissed = null;
    audit(st, actor, 'candidate:undismissed', { candidateId: cand.id });
    touch(st, ['candidates'], 'candidates');
    send(res, 200, { candidate: { id: cand.id, summary: cand.summary } });
  },

  // View items that overflowed the cap and were archived to disk. Viewing clears
  // the "unseen" counter so the badge is never a permanent noise banner.
  'GET /api/candidates/archive': (req, res, q) => {
    const st = getProject(q);
    let rows = [];
    try {
      rows = fs.readFileSync(path.join(st.dir, 'candidates-archive.jsonl'), 'utf8')
        .trim().split('\n').filter(Boolean).slice(-200).map(l => JSON.parse(l)).reverse();
    } catch {}
    if (st.control.candidateArchive?.unseen) { st.control.candidateArchive.unseen = 0; touch(st, ['control'], 'control'); }
    send(res, 200, { items: rows, total: st.control.candidateArchive?.total || 0 });
  },

  'POST /api/settings': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const patch = body.patch || {};
    if (patch.autoApplySchedule !== undefined) st.control.settings.autoApplySchedule = !!patch.autoApplySchedule;
    audit(st, actor, 'settings:updated', st.control.settings);
    touch(st, ['control'], 'control');
    send(res, 200, { settings: st.control.settings });
  },

  'POST /api/control/pause': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (st.control.state === 'paused') throw httpErr(409, 'already paused');
    st.control.state = 'pause_requested';
    st.control.pauseRequestedAt = new Date().toISOString(); // reconciler expires a stuck pause_requested
    audit(st, actor, 'control:pause-requested', {});
    touch(st, ['control'], 'control');
    send(res, 200, { state: st.control.state });
  },

  'POST /api/control/cancel-pause': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (st.control.state === 'pause_requested') st.control.state = st.control.session ? 'running' : 'idle';
    audit(st, actor, 'control:pause-cancelled', {});
    touch(st, ['control'], 'control');
    send(res, 200, { state: st.control.state });
  },

  'POST /api/notes': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (!body.text) throw httpErr(400, 'text required');
    st.control.directives.push({ id: newId('dir'), type: 'note', payload: String(body.text), createdAt: new Date().toISOString(), deliveredAt: null, deliveringSession: null, consumedAt: null });
    audit(st, actor, 'note:queued', { text: String(body.text).slice(0, 200) });
    touch(st, ['control'], 'control');
    send(res, 200, {});
  },

  // Cancel a queued directive that has not yet been acted on. An already-delivered
  // note (deliveredAt set) can't be un-sent — the loop may already be acting on it.
  'DELETE /api/notes': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const id = q.get('id');
    const d = st.control.directives.find(x => x.id === id);
    if (!d) throw httpErr(404, 'directive not found');
    if (d.consumedAt || d.deliveredAt) throw httpErr(409, 'already delivered to the loop — cannot cancel');
    st.control.directives = st.control.directives.filter(x => x.id !== id);
    audit(st, actor, 'note:cancelled', { id });
    touch(st, ['control'], 'control');
    send(res, 200, {});
  },

  'POST /api/session/register': async (req, res, q, body, actor) => {
    const st = getProject(q);
    const resumed = st.control.state === 'paused';
    const incomingId = (typeof body.sessionId === 'string' && body.sessionId) || req.headers['x-ub-session'] || newId('sess');
    // a live working session cannot be hijacked by another session invoking the
    // skill for add/status — the newcomer becomes a guest, not the owner
    const cur = st.control.session;
    if (cur && cur.id !== incomingId && st.control.state === 'running' && cur.lastSeen && Date.now() - Date.parse(cur.lastSeen) < STALE_AFTER) {
      return send(res, 200, {
        registered: false, resumed: false, state: st.control.state, pausedInfo: null,
        activeSession: { id: cur.id, lastSeen: cur.lastSeen },
        note: 'another session owns the work loop — you may capture tasks but must not run the loop or pause/idle it',
      });
    }
    const maxRisk = ['low', 'medium'].includes(body.maxRisk) ? body.maxRisk : null; // bounded safe-lane run ceiling
    st.control.session = { id: incomingId, registeredAt: new Date().toISOString(), lastSeen: new Date().toISOString(), ...(maxRisk ? { maxRisk } : {}) };
    st.control.lastOwnerId = incomingId; // only this id may later re-adopt via /api/next
    st.control.epoch = (st.control.epoch || 0) + 1; // audit metadata only — NOT a liveness signal (never gates the GSD wall-clock)
    st.control.hooksLive = false; // fresh session re-proves its hooks via the first heartbeat; a hook-less one keeps the 45min window
    // a pending pause request survives registration — it will surface via /api/next
    if (st.control.state !== 'pause_requested') st.control.state = 'running';
    // Non-destructive checkpoint read: copy into pausedHistory (keep 5) BEFORE nulling
    // the active slot, so a lost register response is never the only copy — `ub handoff`
    // reprints it. If a prior resume already consumed the active slot, hand back the
    // latest history entry so a second resume still gets the checkpoint.
    const active = st.control.pausedInfo;
    if (active) {
      st.control.pausedHistory = [...(st.control.pausedHistory || []), active].slice(-5);
      st.control.resumePending = true;
    }
    st.control.pausedInfo = null;
    const pausedInfo = active || (st.control.resumePending ? (st.control.pausedHistory?.at(-1) || null) : null);
    // a resumed task named in the checkpoint gets its lease re-stamped to THIS session
    // (register is the only moment pausedInfo is still readable) so the reclaim sweep
    // does not yank a task the fresh session is about to continue
    let tasksRestamped = false;
    if (pausedInfo?.currentTaskId) {
      const t = findTask(st, pausedInfo.currentTaskId);
      if (t && t.status === 'in_progress') { stampLease(st, t); tasksRestamped = true; }
    }
    // tasks left in_progress by a session that vanished without pausing need reconciling
    const inProgress = st.tasks.tasks.filter(t => t.status === 'in_progress').map(t => ({ id: t.id, title: t.title }));
    audit(st, actor, resumed ? 'session:resumed' : 'session:registered', { sessionId: st.control.session.id, epoch: st.control.epoch });
    touch(st, tasksRestamped ? ['control', 'tasks'] : ['control'], 'control');
    send(res, 200, { registered: true, resumed, pausedInfo, state: st.control.state, inProgress });
  },

  'POST /api/session/paused': async (req, res, q, body, actor) => {
    const st = getProject(q);
    requireOwner(st, req, actor);
    st.control.state = 'paused';
    st.control.resumePending = false; // a fresh pause supersedes any pending resume
    st.control.pausedInfo = {
      at: new Date().toISOString(),
      method: body.method || 'unknown', // gsd-pause-work | ub-handoff
      currentTaskId: body.currentTaskId || null,
      resumeSteps: body.resumeSteps || ['/clear', '/gsd-resume-work', '/unfinished-business continue'],
      note: body.note || '',
    };
    audit(st, actor, 'session:paused', st.control.pausedInfo);
    touch(st, ['control'], 'control');
    send(res, 200, { state: 'paused' });
  },

  'POST /api/session/idle': async (req, res, q, body, actor) => {
    const st = getProject(q);
    requireOwner(st, req, actor);
    // only the operator (uiToken) may FORCE past blockers — Claude's cliToken cannot
    const force = actor === 'operator' && body.force === true;
    const blockers = idleBlockers(st);
    if (blockers.length && !force) {
      return send(res, 409, {
        error: 'queue is not quiescent — refusing to idle',
        blockers,
        hint: st.control.state === 'pause_requested'
          ? 'a pause was requested — run the pause procedure (`ub paused`), do not idle or force'
          : 'this is a checklist, not an obstacle: clear each blocker and idle will succeed. Never pass --force yourself; only the operator can force from the UI.',
      });
    }
    // bounded idle (a --max-risk run drained its lane) is NOT true quiescence — record
    // the ceiling + the above-ceiling tasks it left so the report/UI don't over-claim
    const ceil = st.control.session?.maxRisk;
    const deferredByCeiling = ceil ? st.tasks.tasks.filter(t => ['ready', 'inbox'].includes(t.status) && !t.deferred && RISK_RANK[t.risk] > RISK_RANK[ceil]).map(t => t.id) : [];
    st.control.state = 'idle';
    st.control.session = null;
    audit(st, actor, 'session:idle', { reason: body.reason || 'loop ended', ...(force && blockers.length ? { forcedOverBlockers: blockers } : {}), ...(ceil ? { bounded: true, maxRisk: ceil, deferredByCeiling } : {}) });
    touch(st, ['control'], 'control');
    send(res, 200, { state: 'idle', ...(force && blockers.length ? { forced: true, blockers } : {}), ...(ceil ? { bounded: true, maxRisk: ceil, leftAboveCeiling: deferredByCeiling.length } : {}) });
  },

  'GET /api/next': (req, res, q, body, actor) => {
    const st = getProject(q); // heartbeat + prior-note ack + re-adoption handled centrally in the request handler
    requireOwner(st, req, actor); // re-adoption already ran; a genuine guest is refused here
    // convenience: `ub next --max-risk low` sets the bounded ceiling on the owner session
    const mr = q.get('maxRisk');
    if (st.control.session && ['low', 'medium', ''].includes(mr ?? '') && mr !== null) {
      if (mr === '') delete st.control.session.maxRisk; else st.control.session.maxRisk = mr;
      touch(st, ['control'], 'control');
    }
    // 1. pause has priority
    if (st.control.state === 'pause_requested') {
      saveProject(st, ['control']);
      return send(res, 200, { directive: { type: 'pause' } });
    }
    // 2. operator notes — DELIVER (not consume). Ack happens on this session's next
    //    authed call; if it dies first, the next session gets it redelivered.
    const note = st.control.directives.find(d => !d.consumedAt && d.type === 'note');
    if (note) {
      const caller = req.headers['x-ub-session'] || st.control.session?.id || null;
      const redelivered = !!note.deliveredAt && note.deliveringSession !== caller;
      note.deliveredAt = new Date().toISOString();
      note.deliveringSession = caller;
      touch(st, ['control'], 'control');
      return send(res, 200, { directive: { type: 'note', text: note.payload, id: note.id, ...(redelivered ? { redelivered: true } : {}) } });
    }
    // 3. triage nudge — captured signals are work too; a busy loop must not sail past
    //    them to quiescence. Fires when >5 untriaged OR the oldest is >24h, on a 30min
    //    cooldown; stamped when SERVED so it can't refire-and-be-ignored.
    const untriagedC = st.candidates.items.filter(c => !c.dismissed && !c.promotedTaskId);
    if (untriagedC.length) {
      const oldest = untriagedC.reduce((m, c) => Math.min(m, Date.parse(c.ts) || Date.now()), Date.now());
      const cooldownOk = !st.control.lastTriageAt || Date.now() - Date.parse(st.control.lastTriageAt) > 30 * 60_000;
      if (cooldownOk && (untriagedC.length > 5 || Date.now() - oldest > 24 * 3600_000)) {
        st.control.lastTriageAt = new Date().toISOString();
        touch(st, ['control'], 'control');
        return send(res, 200, { directive: { type: 'triage',
          candidates: untriagedC.slice(0, 10).map(c => ({ id: c.id, kind: c.kind, summary: c.summary.slice(0, 200) })),
          hint: `${untriagedC.length} captured signal(s) await triage — promote real work (ub candidates --promote <id>) or dismiss noise (--dismiss <id> --reason "..."), then continue the loop` } });
      }
    }
    // 4. next task
    const next = pickNext(st);
    if (next.task) {
      const t = next.task;
      // a reclaimed task (its prior session died mid-work) is redelivered — flag it
      // once so the loop reconciles against the evidence trail before redoing work
      const redelivered = !!t.reclaimed;
      if (redelivered) { t.reclaimed = false; touch(st, ['tasks'], 'tasks'); }
      return send(res, 200, { task: {
        id: t.id, revision: t.revision, title: t.title, status: t.status, instructions: t.instructions,
        plan: t.prep.plan, acceptanceCriteria: t.acceptanceCriteria,
        subtasks: t.subtasks.filter(s => s.status === 'open'), engine: t.engine, size: t.size, risk: t.risk,
        dependsOn: t.dependsOn, author: t.author, prepState: t.prep.state,
      }, wave: next.wave, ...(redelivered ? { redelivered: true, redeliveredHint: 'this task was reclaimed from a session that died mid-work — check its subtasks/activity/evidence and continue from where it stopped, do not restart from scratch' } : {}) });
    }
    if (next.waiting) return send(res, 200, { waiting: next.waiting, hint: 'preparation or peers in progress — check again shortly or work on verification' });
    const needsOperator = st.tasks.tasks.filter(t => ['awaiting_operator', 'blocked'].includes(t.status)).map(t => ({ id: t.id, title: t.title, status: t.status, reason: t.blockedReason, ...(t.slaFlag ? { waitingHours: t.slaFlag } : {}) }));
    const review = st.tasks.tasks.filter(t => t.status === 'review').map(t => ({ id: t.id, title: t.title }));
    // in_progress tasks in an otherwise-empty payload are orphans (no live claimer) —
    // surface them so a session/operator can reconcile rather than lose them
    const orphaned = st.tasks.tasks.filter(t => t.status === 'in_progress').map(t => ({ id: t.id, title: t.title, leaseExpired: leaseExpired(t) }));
    // ready tasks stranded behind a snoozed/deferred dependency — otherwise invisible
    const depBlocked = st.tasks.tasks.filter(t => ['ready', 'inbox'].includes(t.status) && !t.deferred
      && t.dependsOn.some(d => { const dep = findTask(st, d); return dep && dep.deferred; }))
      .map(t => ({ id: t.id, title: t.title, waitingOn: t.dependsOn.filter(d => findTask(st, d)?.deferred) }));
    send(res, 200, { empty: true, needsOperator, review, ...(orphaned.length ? { orphaned } : {}), ...(depBlocked.length ? { depBlocked } : {}), hint: orphaned.length ? 'in_progress task(s) with no active loop — reconcile (continue or reset to ready)' : depBlocked.length ? 'ready task(s) are stranded behind a snoozed dependency — restore it or drop the dep' : review.length ? 'tasks in review status need verification before quiescence' : needsOperator.length ? 'only operator-blocked tasks remain' : 'queue is empty — run a residual sweep before declaring quiescence' });
  },

  // Operator-only: clear SAFE MODE after reconciling the store (or restoring a
  // backup). Re-READS the (now-fixed) files from disk into memory — it must NOT
  // persist the empty in-memory image over the restored files.
  'POST /api/recover': async (req, res, q, body, actor) => {
    const st = getProject(q);
    if (actor !== 'operator') throw httpErr(403, 'only the operator can recover a project from safe mode');
    if (!st.degraded) return send(res, 200, { recovered: true, note: 'project was not in safe mode' });
    if (body.acknowledge !== true) throw httpErr(400, 'set acknowledge:true to confirm the store has been reconciled or restored');
    let degraded = false;
    const part = (name, fb) => { const r = readStorePart(path.join(st.dir, `${name}.json`), fb); if (r.degraded) degraded = true; return r.data; };
    const fresh = {
      tasks: part('tasks', { tasks: [], seq: 0 }),
      schedule: part('schedule', { active: null, pending: null, history: [] }),
      jobs: part('jobs', { jobs: [] }),
      control: part('control', { state: 'idle', directives: [], session: null, pausedInfo: null }),
      candidates: part('candidates', { items: [] }),
      questions: part('questions', { items: [] }),
    };
    if (degraded) throw httpErr(409, 'store is STILL corrupt — restore a backup (ub restore --apply) or fix the file, then recover again');
    Object.assign(st, fresh);
    st.control.settings = { ...DEFAULT_SETTINGS, ...(st.control.settings || {}) };
    st.degraded = false;
    loadLastAudit(st);
    audit(st, 'operator', 'store:recovered', {});
    broadcast(st.id, 'refresh');
    send(res, 200, { recovered: true, tasks: st.tasks.tasks.length });
  },

  'GET /api/artifact': (req, res, q) => {
    const st = getProject(q);
    const rel = q.get('path') || '';
    const abs = path.resolve(st.dir, rel);
    if (!abs.startsWith(path.resolve(st.dir) + path.sep)) throw httpErr(403, 'path escapes project store');
    if (!fs.existsSync(abs)) throw httpErr(404, 'artifact not found');
    send(res, 200, fs.readFileSync(abs, 'utf8'));
  },

  'GET /api/audit': (req, res, q) => {
    const st = getProject(q);
    let lines = [];
    try { lines = fs.readFileSync(path.join(st.dir, 'audit.jsonl'), 'utf8').trim().split('\n').slice(-300).map(l => JSON.parse(l)); } catch {}
    send(res, 200, { events: lines.reverse() });
  },
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw httpErr(403, 'loopback only');

    // static UI
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const uiDir = path.resolve(__dirname, 'ui');
      let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const abs = path.resolve(uiDir, rel);
      if (abs !== uiDir && !abs.startsWith(uiDir + path.sep)) throw httpErr(403, 'nope');
      if (!fs.existsSync(abs)) throw httpErr(404, 'not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      return res.end(fs.readFileSync(abs));
    }

    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) throw httpErr(404, `no route ${key}`);

    const isMutation = req.method !== 'GET';
    const isOpen = ['GET /api/health', 'POST /api/bootstrap'].includes(key);
    const actor = actorFor(req, url);
    if (!isOpen && !actor) {
      // GET endpoints also require a token (they expose task content)
      throw httpErr(401, 'missing or invalid X-UB-Token');
    }
    // Heartbeat: only the REGISTERED working session's calls refresh lastSeen —
    // a mid-task session PATCHes for a long time without calling /api/next and
    // must not go stale, but an unrelated terminal poking the CLI must not
    // revive a dead session either. Sessionless callers only count via /api/next.
    if (actor === 'claude') {
      const hb = projects.get(url.searchParams.get('project'));
      const sess = req.headers['x-ub-session'];
      if (hb?.control.session && (sess === hb.control.session.id
        // sessionless /api/next only counts when the stored id is itself a fallback id —
        // a monitoring terminal must not keep a dead real session alive
        || (!sess && url.pathname === '/api/next' && String(hb.control.session.id).startsWith('sess-')))) {
        hb.control.session.lastSeen = new Date().toISOString();
        // extend this owner's task leases so a long engine run never loses its claim
        for (const t of hb.tasks.tasks) {
          if (t.status === 'in_progress' && t.lease && t.lease.sessionId === hb.control.session.id) {
            t.lease.expiresAt = new Date(Date.now() + TASK_LEASE_MS).toISOString();
            hb._leaseDirty = true; // persisted by the 60s sweep, not per-request
          }
        }
        // ack notes delivered to this session on its previous call; a live owner also
        // clears the resume-pending flag on any call AFTER register (not register
        // itself — a lost register response must still let a second register recover
        // the checkpoint from history)
        const sessionless = !sess && String(hb.control.session.id).startsWith('sess-');
        let ctlChanged = ackDeliveredNotes(hb, sess, sessionless);
        if (hb.control.resumePending && url.pathname !== '/api/session/register') { hb.control.resumePending = false; ctlChanged = true; }
        if (ctlChanged) touch(hb, ['control'], 'control');
      }
      // recovery: the watchdog (or a restart) dropped the session while the loop was
      // inside a long engine run — the next loop tick re-adopts it. Only the ORIGINAL
      // owner (lastOwnerId) may re-adopt, so a monitoring terminal can't steal the loop
      // via a casual /api/next. Runs BEFORE the ownership check below, so a legitimately
      // dropped owner recovers instead of 403ing.
      if (hb && !hb.control.session && sess && sess === hb.control.lastOwnerId && hb.control.state !== 'paused' && url.pathname === '/api/next') {
        hb.control.session = { id: sess, registeredAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
        if (hb.control.state !== 'pause_requested') hb.control.state = 'running'; // a pending pause survives re-adoption
        // renew claims on any in_progress tasks under the re-adopted session
        for (const t of hb.tasks.tasks) if (t.status === 'in_progress') stampLease(hb, t);
        audit(hb, 'system', 'session:readopted', { sessionId: sess });
        touch(hb, ['control', 'tasks'], 'control');
      }
    }
    // SAFE MODE gate: refuse mutations against a degraded project (except capture,
    // which spools, and recover, which clears it). Reads stay open.
    if (isMutation && !['POST /api/tasks', 'POST /api/recover', 'POST /api/projects', 'POST /api/ui-launch', 'POST /api/bootstrap'].includes(key)) {
      const pid = url.searchParams.get('project');
      const pst = pid && projects.get(pid);
      if (pst?.degraded) throw httpErr(503, 'project is in SAFE MODE (store corruption detected) — mutations are paused. Operator: reconcile the store then POST /api/recover {acknowledge:true}, or restore a backup.');
    }
    const body = isMutation ? await readBody(req) : {};
    await handler(req, res, url.searchParams, body, actor);
  } catch (e) {
    const code = e.statusCode || 500;
    if (code === 500) log('http 500', req.method, String(req.url).replace(/([?&]token=)[^&]*/g, '$1[redacted]'), e.stack || String(e));
    if (!res.headersSent) send(res, code, { error: String(e.message || e), ...(e.body || {}) });
  }
});

function start(port) {
  server.listen(port, '127.0.0.1', () => {
    serverInfo = loadOrCreateServerInfo(server.address().port);
    log(`Unfinished Business server v${VERSION} on http://127.0.0.1:${serverInfo.port} (pid ${process.pid}, cli: ${CLAUDE_CLI ? 'found' : 'MISSING'})`);
    // eagerly load every registered project so the watchdog, reconciler, job pump and
    // backups cover them immediately — lazy loading otherwise froze queued jobs and
    // stuck 'preparing' tasks until someone happened to open that project
    for (const p of registry.projects) { try { loadProject(p.id); } catch (e) { log('startup load failed', p.id, String(e)); } }
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      // lost a startup race — if a healthy UB server owns the port, defer to it.
      // Never fall back to an ephemeral port: two live servers writing the same
      // project files would break the single-writer invariant (split-brain).
      probeHealth(PREFERRED_PORT, ok => {
        if (ok) { log('another UB server owns the port — exiting'); process.exit(0); }
        log(`port ${PREFERRED_PORT} is held by a foreign process — exiting`); process.exit(1);
      });
    } else { log('server error', String(err)); process.exit(1); }
  });
}

function probeHealth(port, cb) {
  let decided = false;
  const done = ok => { if (!decided) { decided = true; cb(ok); } };
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, r => {
    let b = ''; r.on('data', d => b += d);
    r.on('end', () => { try { done(JSON.parse(b).ok === true); } catch { done(false); } });
  });
  req.on('error', () => done(false));
  req.on('timeout', function () { this.destroy(); done(false); });
}

// refuse to double-start
const prev = readJson(SERVER_JSON, null);
if (prev?.port) {
  probeHealth(prev.port, ok => {
    if (ok) { log(`server already running on port ${prev.port} — exiting`); process.exit(0); }
    start(PREFERRED_PORT);
  });
} else start(PREFERRED_PORT);
