#!/usr/bin/env node
// Unfinished Business — CLI used by Claude (and scripts) to talk to the server.
// Every command prints JSON to stdout. Exit 0 = success, 1 = error.
// Usage: node ub.mjs <verb> [args] [--project <path>]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coerceLoopbackPort } from './security.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'UnfinishedBusiness');
const SERVER_JSON = path.join(ROOT, 'server.json');

// ---------------------------------------------------------------- arg parsing
const argv = process.argv.slice(2);
const verb = argv[0];
const args = [];
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; } // --flag=value (values may start with --)
    const key = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { flags[key] = argv[++i]; }
    else flags[key] = true;
  } else args.push(a);
}
const projectPath = path.resolve(flags.project || process.cwd());

function out(obj) { console.log(JSON.stringify(obj, null, 2)); }
function die(msg, extra = {}) { console.log(JSON.stringify({ error: msg, ...extra }, null, 2)); process.exit(1); }
// string-valued flags must not silently become boolean true (e.g. --text "--urgent")
function strFlag(name) {
  if (flags[name] === true) die(`--${name} needs a value; for values starting with --, use --${name}="..."`);
  return flags[name];
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

// ---------------------------------------------------------------- server access
function serverInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8'));
    const port = coerceLoopbackPort(info.port);
    return port ? { ...info, port } : null;
  } catch { return null; }
}

async function health(info) {
  if (!info?.port) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return (await r.json()).ok === true;
  } catch { return false; }
}

async function ensureServer() {
  let info = serverInfo();
  if (await health(info)) return info;
  const serverPath = path.join(__dirname, 'ub-server.mjs');
  if (!fs.existsSync(serverPath)) die(`server not found at ${serverPath}`);
  const child = spawn(process.execPath, [serverPath], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname,
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    info = serverInfo();
    if (await health(info)) return info;
  }
  die('server failed to start within 15s — check ' + path.join(ROOT, 'server.log'));
}

let _info = null, _projectId = null;
async function api(method, route, body, query = {}) {
  if (!_info) {
    _info = serverInfo();
    if (!(await health(_info))) _info = await ensureServer();
  }
  const q = new URLSearchParams(query);
  if (_projectId && !q.has('project')) q.set('project', _projectId);
  const url = `http://127.0.0.1:${_info.port}${route}${q.size ? '?' + q : ''}`;
  const headers = { 'X-UB-Token': _info.cliToken, 'Content-Type': 'application/json' };
  // identify the calling session so only the registered working session heartbeats
  if (process.env.CLAUDE_CODE_SESSION_ID) headers['X-UB-Session'] = process.env.CLAUDE_CODE_SESSION_ID;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error || `HTTP ${res.status}`, { route, status: res.status });
  return data;
}

async function ensureProject() {
  const { project } = await api('POST', '/api/projects', { path: projectPath });
  _projectId = project.id;
  return project;
}

async function uiLaunchUrl(projectId = _projectId) {
  const { nonce } = await api('POST', '/api/ui-launch', {});
  return `http://127.0.0.1:${_info.port}/?project=${encodeURIComponent(projectId)}#launch=${encodeURIComponent(nonce)}`;
}

// Throwing variants (they never call die()) so `add` can distinguish a network-level
// failure — spool to the offline outbox — from a 4xx that must surface as an error.
async function tryEnsureServer() {
  let info = serverInfo();
  if (await health(info)) return info;
  const serverPath = path.join(__dirname, 'ub-server.mjs');
  if (!fs.existsSync(serverPath)) { const e = new Error(`server not found at ${serverPath}`); e.network = true; throw e; }
  spawn(process.execPath, [serverPath], { detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    info = serverInfo();
    if (await health(info)) return info;
  }
  const e = new Error('server failed to start within 15s'); e.network = true; throw e;
}
async function tryApi(method, route, body, query = {}) {
  if (!_info || !(await health(_info))) { _info = serverInfo(); if (!(await health(_info))) _info = await tryEnsureServer(); }
  const q = new URLSearchParams(query);
  if (_projectId && !q.has('project')) q.set('project', _projectId);
  const url = `http://127.0.0.1:${_info.port}${route}${q.size ? '?' + q : ''}`;
  const headers = { 'X-UB-Token': _info.cliToken, 'Content-Type': 'application/json' };
  if (process.env.CLAUDE_CODE_SESSION_ID) headers['X-UB-Session'] = process.env.CLAUDE_CODE_SESSION_ID;
  let res;
  try { res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); }
  catch (e) { const err = new Error(`network: ${e.message}`); err.network = true; throw err; }
  const data = await res.json().catch(() => ({}));
  if (res.status >= 500) { const err = new Error(data.error || `HTTP ${res.status}`); err.network = true; err.body = data; throw err; } // server-side failure is spoolable
  if (!res.ok) { const err = new Error(data.error || `HTTP ${res.status}`); err.httpStatus = res.status; err.body = data; throw err; } // 4xx is a real client error
  return data;
}
async function ensureProjectThrowing() {
  const { project } = await tryApi('POST', '/api/projects', { path: projectPath });
  _projectId = project.id;
  return project;
}
// idempotency key so a retried/ambiguous add cannot duplicate (server dedupes on it)
function dedupeKeyFor(title, context, sessionId) {
  return crypto.createHash('sha256').update(`${title}\0${context || ''}\0${sessionId || ''}`).digest('hex').slice(0, 16);
}
function spoolTaskOffline(body, dedupeKey, sessionId) {
  const dir = path.join(ROOT, 'spool', '_tasks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.json`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ kind: 'task', payload: body, projectPath, dedupeKey, sessionId, ts: new Date().toISOString() }));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- verbs
const HELP = `Unfinished Business CLI — verbs:
  ensure                       start server if needed, register this project, print status + UI URL
  register [--session <id>] [--max-risk low|medium]   register the session (--max-risk bounds the run to a safe lane)
  add "<title>" [--instructions <text|->] [--context "why"] [--size s] [--risk r] [--priority n]
                [--deps id,id] [--tags a,b] [--prep off|quick|full] [--model m] [--engine e] [--criteria "a;;b"]
  add [... --kind <sys> --ref <id> [--url <u>]]   mirror an external tracker item; re-import dedupes on kind+ref
  add --json                   read a full task JSON object from stdin
  list [--all] [--tag <t>]     compact list (default: open tasks only; --tag filters to a lane)
  show <id>                    full task
  next                         next directive or task to work on
  update <id> --set-status s | --set-instructions - | --add-criteria "x" | --set-engine e (uses --rev)
  subtask <id> <subId> <open|done|skipped>
  add-subtask <id> "<title>" [--instructions <text|->]
  done <id> --evidence "<text or ->"
  block <id> --reason "..." [--operator] [--retry-after <min|ISO>]  (auto-retry-to-ready when due)
  later <id> [--off] [--until <ISO>|--days N]  snooze with a guaranteed return date (default 7d)
  note --text "..."            queue a note (normally used by the UI)
  prep <id> [--mode m] [--model m] [--directive "..."]   queue a planning session
  order [--parallel]           queue an ordering session
  paused [--method gsd-pause-work|ub] [--task id] [--note "context for resume"]
  handoff                      reprint the latest pause checkpoint (durable; survives a lost register response)
  idle [--reason "..."]        mark loop ended (queue empty)
  status                       control state, counts, jobs, UI URL
  council <id> --question "..." [--options "a;;b"] [--n 3|5|7]   5-voter council in separate sessions
  ask "<question>" [--model m]    side question answered by a separate session (non-blocking)
  candidates [--promote id | --dismiss id --reason "..."]        triage hook-captured signals
  verify-audit                 verify the audit log hash chain
  restore [--apply]            recover the store from the newest backup (dry-run without --apply)
  hooks <install|uninstall|status>   manage UB hook entries in ~/.claude/settings.json
  mcp print-config [--write-project <path>]   register the MCP bridge for a project
  login [--token -]            one-time auth; fallback token input is accepted only on stdin

  Flags: --flag value or --flag="value" (use = form for values starting with --)`;

const verbs = {
  async help() { console.log(HELP); },

  // One-time interactive login for headless planning sessions. Uses UB's own
  // CLAUDE_CONFIG_DIR so it never touches the Claude Desktop app's credentials.
  async login() {
    const cli = [
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@gsd-build', 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js'),
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    ].find(p => fs.existsSync(p));
    if (!cli) die('Claude CLI not found for login');
    if (flags.token) {
      if (flags.token !== '-') die('tokens are accepted only on stdin: use `login --token -` and pipe the value');
      const oauthToken = (await readStdin()).trim();
      if (!oauthToken) die('no token received on stdin');
      fs.mkdirSync(ROOT, { recursive: true });
      fs.writeFileSync(
        path.join(ROOT, 'auth.json'),
        JSON.stringify({ oauthToken, savedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
      return out({ ok: true, note: 'token saved — headless planning sessions will use it' });
    }
    const configDir = path.join(ROOT, 'claude-config');
    fs.mkdirSync(configDir, { recursive: true });
    console.log('Opening one-time login for Unfinished Business planning sessions.');
    console.log('A browser window will open; approve access, then this finishes on its own.\n');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    for (const k of Object.keys(env)) if (/^(CLAUDE(?!_CONFIG_DIR)|ANTHROPIC)/i.test(k)) delete env[k];
    env.CLAUDE_CONFIG_DIR = configDir;
    // `auth login` persists credentials (with auto-refresh) into the UB config
    // dir — no token printing/pasting, unlike setup-token
    const child = spawn(process.execPath, [cli, 'auth', 'login'], { stdio: 'inherit', env });
    await new Promise(r => child.on('close', r));
    const credFile = path.join(configDir, '.credentials.json');
    let ok = false;
    try { ok = !!JSON.parse(fs.readFileSync(credFile, 'utf8'))?.claudeAiOauth?.accessToken; } catch {}
    if (ok) {
      // a stale saved token would override the fresh credentials — remove it
      try { fs.unlinkSync(path.join(ROOT, 'auth.json')); } catch {}
      console.log('\n✓ Logged in — credentials stored for headless planning sessions. No further steps.');
    } else {
      console.log('\nLogin did not persist credentials. Fallback: pipe a setup token on stdin to  node ub.mjs login --token -');
    }
  },

  async ensure() {
    const project = await ensureProject();
    const st = await api('GET', '/api/state');
    const hooks = hooksCoverage();
    out({
      ok: true, project, url: await uiLaunchUrl(project.id),
      state: st.control.state, tasks: summarize(st.tasks),
      claudeCli: st.server.claudeCli, headlessAuth: st.server.headlessAuth,
      hooks: { installed: hooks.installed.length, missing: hooks.missing },
      ...(hooks.missing.length ? { hooksHint: 'some enforcement hooks are missing — run `ub hooks install` (takes effect in new sessions)' } : {}),
      ...(st.server.headlessAuth === 'required' ? { loginCommand: st.server.loginCommand } : {}),
    });
  },

  async register() {
    await ensureProject();
    // prefer the real Claude session id (stop guard + GSD gate match on it);
    // strFlag rejects a bare --session so a boolean can never become the id
    const sessionId = strFlag('session') || process.env.CLAUDE_CODE_SESSION_ID || `sess-${Date.now().toString(36)}`;
    // --max-risk low|medium: bounded run — the loop pulls only tasks at/below this risk
    const r = await api('POST', '/api/session/register', { sessionId, ...(flags['max-risk'] ? { maxRisk: strFlag('max-risk') } : {}) });
    out(r);
  },

  async add() {
    let body;
    if (flags.json) {
      body = JSON.parse(await readStdin());
    } else {
      const title = args[0];
      if (!title) die('usage: add "<title>" [flags]');
      let instructions = strFlag('instructions') || '';
      if (instructions === '-') instructions = await readStdin();
      body = {
        title, instructions,
        acceptanceCriteria: flags.criteria ? String(strFlag('criteria')).split(';;').map(s => s.trim()).filter(Boolean) : [],
        size: flags.size, risk: flags.risk, engine: flags.engine,
        priority: flags.priority ? Number(flags.priority) : undefined,
        dependsOn: flags.deps ? String(flags.deps).split(',').map(s => s.trim()).filter(Boolean) : [],
        tags: flags.tags ? String(strFlag('tags')).split(',').map(s => s.trim()).filter(Boolean) : undefined,
        prep: { mode: flags.prep, model: flags.model, auto: flags.prep !== 'off', directive: strFlag('directive') },
        source: { context: strFlag('context') || '' },
        authorKind: flags['from-operator'] ? 'operator' : undefined,
        authorDetail: flags.author || (flags['from-operator'] ? 'dictated to Claude' : 'main-session'),
        // pointer to an external canonical source; re-importing the same --ref dedupes
        linkedSource: flags.ref ? { kind: strFlag('kind') || '', ref: strFlag('ref'), url: strFlag('url') || '' } : undefined,
      };
    }
    // Capture must survive a down/unreachable server: attach an idempotency key,
    // try online, and on ANY network-level failure spool to the offline outbox
    // (exit 0). A 4xx is a real error and must surface — never spool garbage.
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID || '';
    const dedupeKey = dedupeKeyFor(body.title, body.source?.context, sessionId);
    body.dedupeKey = dedupeKey;
    try {
      await ensureProjectThrowing();
      const r = await tryApi('POST', '/api/tasks', body);
      out({ ok: true, id: r.task.id, title: r.task.title, status: r.task.status, prep: r.task.prep.state, ...(r.duplicate ? { duplicate: true } : {}) });
    } catch (e) {
      if (e.httpStatus) die(e.message, { status: e.httpStatus });
      try { spoolTaskOffline(body, dedupeKey, sessionId); }
      catch (se) { die(`server unreachable AND offline outbox write failed: ${se.message}`); }
      out({ ok: true, captured: 'offline', willSync: true, dedupeKey, note: 'server unreachable — task written to the offline outbox and will sync automatically. Retrying this exact add is always safe (the server dedupes on the idempotency key).' });
    }
  },

  async list() {
    await ensureProject();
    const st = await api('GET', '/api/state');
    const tag = flags.tag ? String(strFlag('tag')) : null;
    const tasks = st.tasks
      .filter(t => flags.all || !['done', 'archived'].includes(t.status))
      .filter(t => !tag || (t.tags || []).includes(tag));
    out(tasks.map(t => ({
      id: t.id, title: t.title, status: t.status, author: t.author.kind,
      priority: t.priority, size: t.size, risk: t.risk, engine: t.engine,
      prep: t.prep.state, deps: t.dependsOn, tags: t.tags, subtasks: `${t.subtasks.filter(s => s.status === 'done').length}/${t.subtasks.length}`,
    })));
  },

  async show() {
    await ensureProject();
    out(await currentTask(args[0]));
  },

  async next() {
    await ensureProject();
    // --max-risk low|medium sets the bounded ceiling; --max-risk="" clears it
    const q = flags['max-risk'] !== undefined ? { maxRisk: flags['max-risk'] === true ? '' : String(flags['max-risk']) } : {};
    out(await api('GET', '/api/next', undefined, q));
  },

  async update() {
    await ensureProject();
    const id = args[0]; if (!id) die('usage: update <id> [--set-* flags] [--rev N]');
    const t = await currentTask(id);
    const patch = {};
    if (flags['set-status']) patch.status = flags['set-status'];
    if (flags['set-engine']) patch.engine = flags['set-engine'];
    if (flags['set-size']) patch.size = flags['set-size'];
    if (flags['set-risk']) patch.risk = flags['set-risk'];
    if (flags['set-priority']) patch.priority = Number(flags['set-priority']);
    if (flags['set-title']) patch.title = flags['set-title'];
    if (flags['set-instructions']) patch.instructions = flags['set-instructions'] === '-' ? await readStdin() : flags['set-instructions'];
    if (flags['add-criteria']) patch.acceptanceCriteria = [...t.acceptanceCriteria, strFlag('add-criteria')];
    if (flags['set-deps']) patch.dependsOn = String(flags['set-deps']).split(',').map(s => s.trim()).filter(Boolean);
    if (flags['set-tags'] !== undefined) patch.tags = String(strFlag('set-tags')).split(',').map(s => s.trim()).filter(Boolean);
    if (flags['set-plan']) {
      const plan = flags['set-plan'] === '-' ? await readStdin() : flags['set-plan'];
      patch.prep = { ...(patch.prep || {}), plan, state: 'ready' };
      // only lift a task INTO the pickable set — never yank one out of
      // in_progress/blocked/review/done just because its plan was refreshed
      if (!patch.status && ['inbox', 'preparing'].includes(t.status)) patch.status = 'ready';
    }
    if (flags.reason) patch.blockedReason = flags.reason;
    const body = { patch, expectedRevision: flags.rev ? Number(flags.rev) : t.revision };
    const r = await api('PATCH', '/api/tasks', body, { id: t.id });
    out({ ok: true, id: r.task.id, revision: r.task.revision, status: r.task.status });
  },

  async subtask() {
    await ensureProject();
    const [id, subId, state] = args;
    if (!id || !subId || !['open', 'done', 'skipped'].includes(state)) die('usage: subtask <id> <subId> <open|done|skipped>');
    const t = await currentTask(id);
    const matches = t.subtasks.filter(s => s.id === subId || s.id.endsWith(subId));
    if (matches.length !== 1) die(matches.length ? `ambiguous subtask ${subId}` : `subtask ${subId} not found`);
    const subtasks = t.subtasks.map(s => s === matches[0] ? { ...s, status: state } : s);
    const r = await api('PATCH', '/api/tasks', { expectedRevision: t.revision, patch: { subtasks } }, { id: t.id });
    out({ ok: true, id: r.task.id, subtasks: r.task.subtasks.map(s => ({ id: s.id, title: s.title, status: s.status })) });
  },

  async 'add-subtask'() {
    await ensureProject();
    const [id, title] = args;
    if (!id || !title) die('usage: add-subtask <id> "<title>" [--instructions <text|->]');
    let instructions = strFlag('instructions') || '';
    if (instructions === '-') instructions = await readStdin();
    const t = await currentTask(id);
    const subtasks = [...t.subtasks, { title, instructions, status: 'open' }];
    const r = await api('PATCH', '/api/tasks', { expectedRevision: t.revision, patch: { subtasks } }, { id: t.id });
    out({ ok: true, id: r.task.id, count: r.task.subtasks.length });
  },

  async done() {
    await ensureProject();
    const id = args[0]; if (!id) die('usage: done <id> --evidence "<text or ->"');
    let evidence = strFlag('evidence');
    if (!evidence) die('done requires --evidence (what was verified and how)');
    if (evidence === '-') evidence = await readStdin();
    if (!evidence.trim()) die('evidence cannot be empty');
    const t = await currentTask(id);
    const r = await api('PATCH', '/api/tasks', {
      expectedRevision: t.revision,
      patch: { verification: { state: 'passed', evidence }, status: 'done' },
    }, { id: t.id });
    out({ ok: true, id: r.task.id, status: r.task.status });
  },

  // later <id> [--off] [--until <ISO>] [--days N] — snooze a task with a GUARANTEED
  // return date (default 7 days). The reconciler resurfaces it when the date passes,
  // so nothing is iced indefinitely by accident (indefinite ice is operator-only, via
  // the UI). --off reopens it now.
  async later() {
    await ensureProject();
    const id = args[0]; if (!id) die('usage: later <id> [--off] [--until <ISO>] [--days N]');
    const t = await currentTask(id);
    const patch = { deferred: !flags.off };
    if (flags.off) patch.deferUntil = null;
    else if (flags.until) patch.deferUntil = strFlag('until');
    else patch.deferUntil = new Date(Date.now() + (flags.days ? Number(flags.days) : 7) * 86400_000).toISOString();
    const r = await api('PATCH', '/api/tasks', { expectedRevision: t.revision, patch }, { id: t.id });
    out({ ok: true, id: r.task.id, deferred: r.task.deferred, ...(r.task.deferUntil ? { until: r.task.deferUntil } : {}), ...(r.strandWarning ? { strandWarning: r.strandWarning } : {}) });
  },

  async block() {
    await ensureProject();
    const id = args[0];
    const reason = strFlag('reason');
    if (!id || !reason) die('usage: block <id> --reason "..." [--operator] [--retry-after <minutes|ISO>]');
    const t = await currentTask(id);
    const patch = { status: flags.operator ? 'awaiting_operator' : 'blocked', blockedReason: String(reason) };
    // --retry-after: auto-return to ready when the time comes (transient blocks:
    // quota/rate-limit resets). Accepts minutes (number) or an ISO timestamp.
    if (flags['retry-after'] !== undefined) {
      const v = strFlag('retry-after');
      patch.blockedRetryAt = /^\d+$/.test(String(v)) ? new Date(Date.now() + Number(v) * 60_000).toISOString() : String(v);
    }
    const r = await api('PATCH', '/api/tasks', { expectedRevision: t.revision, patch }, { id: t.id });
    out({ ok: true, id: r.task.id, status: r.task.status, ...(patch.blockedRetryAt ? { retryAt: patch.blockedRetryAt } : {}) });
  },

  async note() {
    await ensureProject();
    const text = strFlag('text');
    if (!text) die('usage: note --text "..."');
    await api('POST', '/api/notes', { text });
    out({ ok: true });
  },

  // candidates — list hook-captured signals; --promote <id> / --dismiss <id> --reason "..."
  async candidates() {
    await ensureProject();
    if (flags.promote) {
      const r = await api('POST', '/api/candidates/promote', { id: String(flags.promote) });
      return out({ ok: true, taskId: r.task.id, title: r.task.title });
    }
    if (flags.dismiss) {
      await api('POST', '/api/candidates/dismiss', { id: String(flags.dismiss), reason: strFlag('reason') || 'triaged: not actionable' });
      return out({ ok: true, dismissed: flags.dismiss });
    }
    const st = await api('GET', '/api/state');
    out(st.candidates.items.map(c => ({ id: c.id, kind: c.kind, ts: c.ts, summary: c.summary.slice(0, 200) })));
  },

  async prep() {
    await ensureProject();
    const id = args[0]; if (!id) die('usage: prep <id> [--mode m] [--model m] [--directive "..."]');
    const t = await currentTask(id);
    const r = await api('POST', '/api/tasks/prepare', {
      taskId: t.id, mode: flags.mode, model: flags.model, directive: flags.directive,
    });
    out({ ok: true, job: r.job.id });
  },

  async order() {
    await ensureProject();
    const r = await api('POST', '/api/jobs/order', { parallel: !!flags.parallel });
    out({ ok: true, job: r.job.id });
  },

  // ask "<question>" [--model m] — a separate session answers without interrupting execution
  async ask() {
    await ensureProject();
    const question = args[0];
    if (!question) die('usage: ask "<question>" [--model adaptive|haiku|sonnet|opus]');
    const r = await api('POST', '/api/questions', { question, model: flags.model });
    out({ ok: true, id: r.question.id, job: r.job.id, note: 'a separate session is answering — watch the UI Side questions panel or ub status' });
  },

  // council <id> --question "..." [--options "a;;b"] [--n 3|5|7]
  // Convenes N independent headless voters + synthesis on an important decision.
  async council() {
    await ensureProject();
    const id = args[0];
    const question = strFlag('question');
    if (!id || !question) die('usage: council <id> --question "..." [--options "a;;b"] [--n 5]');
    const t = await currentTask(id);
    const r = await api('POST', '/api/tasks/council', {
      taskId: t.id, question,
      options: flags.options ? String(strFlag('options')).split(';;').map(s => s.trim()).filter(Boolean) : [],
      n: flags.n ? Number(flags.n) : 5,
    });
    out({ ok: true, job: r.job.id, note: 'council runs in separate sessions — check `ub show ' + t.id + '` (councils) when the job completes' });
  },

  async paused() {
    await ensureProject();
    const r = await api('POST', '/api/session/paused', {
      method: flags.method || 'unknown',
      currentTaskId: flags.task || null,
      note: flags.note || '',
      resumeSteps: flags.method === 'gsd-pause-work'
        ? ['/clear', '/gsd-resume-work', 'then type: continue']
        : ['/clear', '/unfinished-business continue'],
    });
    out(r);
  },

  // handoff — reprint the latest pause checkpoint (from durable history), any time.
  // Recovers the resume note even if a register response was lost.
  async handoff() {
    await ensureProject();
    const st = await api('GET', '/api/state');
    const hist = st.control.pausedHistory || [];
    const latest = st.control.pausedInfo || hist.at(-1) || null;
    if (!latest) return out({ ok: true, checkpoint: null, note: 'no pause checkpoint on record' });
    out({ ok: true, checkpoint: latest, resumePending: st.control.resumePending, historyDepth: hist.length });
  },

  async idle() {
    await ensureProjectThrowing();
    // idle is REFUSED (409) if the queue is not quiescent — surface the checklist
    // verbatim instead of a bare error. Never pass --force yourself (the server
    // ignores it from Claude's token anyway; only the operator can force via the UI).
    try {
      out(await tryApi('POST', '/api/session/idle', { reason: flags.reason || 'queue empty', force: !!flags.force }));
    } catch (e) {
      if (e.httpStatus === 409 && e.body) return out({ ok: false, refused: true, error: e.body.error, blockers: e.body.blockers, hint: e.body.hint });
      die(e.message, e.httpStatus ? { status: e.httpStatus } : {});
    }
  },

  // mcp print-config [--write-project <path>] — register the MCP bridge for a project.
  async mcp() {
    if (args[0] !== 'print-config') die('usage: mcp print-config [--write-project <path>]');
    const entry = { 'unfinished-business': { command: 'node', args: [path.join(__dirname, 'mcp.mjs')] } };
    if (flags['write-project']) {
      const proj = path.resolve(String(flags['write-project']));
      if (!fs.existsSync(proj)) die(`project path does not exist: ${proj}`);
      const mcpPath = path.join(proj, '.mcp.json');
      let cfg = {};
      if (fs.existsSync(mcpPath)) {
        try { cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); } catch (e) { die(`.mcp.json exists but is invalid JSON — fix it first (${e.message})`); }
      }
      cfg.mcpServers = { ...(cfg.mcpServers || {}), ...entry };
      const tmp = mcpPath + '.tmp-ub';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, mcpPath);
      return out({ ok: true, wrote: mcpPath, note: 'takes effect in new Claude sessions for that project' });
    }
    out({ mcpServers: entry, note: 'merge into <project>/.mcp.json, or run with --write-project <path>' });
  },

  // restore — recover a project's store from its newest backup (disk-level tool).
  // Dry-run by default; --apply copies the backup over the live store (saving the
  // current one as .prerestore first). Reports events recorded after the backup anchor.
  async restore() {
    const project = await ensureProject();
    const STORE_FILES = ['tasks.json', 'schedule.json', 'jobs.json', 'control.json', 'candidates.json', 'questions.json'];
    const pdir = path.join(ROOT, 'projects', project.id);
    const bdir = path.join(pdir, 'backups');
    let backups = [];
    try { backups = fs.readdirSync(bdir).sort(); } catch {}
    if (!backups.length) die('no backups available to restore from');
    const newest = backups.at(-1);
    const src = path.join(bdir, newest);
    let anchor = null; try { anchor = JSON.parse(fs.readFileSync(path.join(src, 'audit-anchor.json'), 'utf8')); } catch {}
    let postAnchor = 0;
    try {
      const lines = fs.readFileSync(path.join(pdir, 'audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      postAnchor = anchor ? lines.filter(l => { try { return JSON.parse(l).seq > (anchor.seq || 0); } catch { return false; } }).length : lines.length;
    } catch {}
    if (!flags.apply) {
      return out({ dryRun: true, newestBackup: newest, anchor, replayableEventsAfterAnchor: postAnchor, availableBackups: backups.length,
        note: 're-run with --apply to copy this backup over the live store (the current store is saved as .prerestore-<ts> first). Events after the anchor remain in audit.jsonl for manual review.' });
    }
    const stamp = Date.now();
    for (const f of STORE_FILES) {
      const live = path.join(pdir, f), bf = path.join(src, f);
      if (fs.existsSync(live)) fs.copyFileSync(live, `${live}.prerestore-${stamp}`);
      if (fs.existsSync(bf)) fs.copyFileSync(bf, live);
    }
    out({ restored: true, from: newest, prerestoreSuffix: `.prerestore-${stamp}`,
      note: 'store restored from backup. If the server is running in safe mode, POST /api/recover {acknowledge:true} (or restart the server) to resume writes.' });
  },

  // verify-audit — walk the project's audit hash chain and report integrity.
  async 'verify-audit'() {
    const project = await ensureProject();
    const file = path.join(ROOT, 'projects', project.id, 'audit.jsonl');
    if (!fs.existsSync(file)) return out({ ok: true, events: 0, note: 'no audit log yet' });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const { createHash } = await import('node:crypto');
    let prevHash = null, chained = 0, legacy = 0, chainStarted = false;
    for (let i = 0; i < lines.length; i++) {
      let ev;
      try { ev = JSON.parse(lines[i]); } catch { die(`line ${i + 1}: unparseable`, { line: i + 1 }); }
      if (!ev.hash) {
        if (chainStarted) die(`line ${i + 1}: unhashed event AFTER chain start — possible tampering`, { line: i + 1 });
        legacy++; continue;
      }
      const base = { seq: ev.seq, ts: ev.ts, actor: ev.actor, action: ev.action, detail: ev.detail, prev: ev.prev };
      const expect = createHash('sha256').update((ev.prev || '') + JSON.stringify(base)).digest('hex').slice(0, 32);
      if (expect !== ev.hash) die(`line ${i + 1}: hash mismatch — event altered or reordered`, { line: i + 1, seq: ev.seq });
      if (chainStarted && ev.prev !== prevHash) die(`line ${i + 1}: broken chain link (prev does not match prior hash)`, { line: i + 1, seq: ev.seq });
      prevHash = ev.hash; chainStarted = true; chained++;
    }
    out({ ok: true, events: lines.length, chained, legacyPrefix: legacy, headHash: prevHash });
  },

  // hooks install|uninstall|status — manage the Unfinished Business entries in
  // ~/.claude/settings.json. Additive and reversible: only entries whose command
  // references this app's hooks.mjs are ever touched.
  async hooks() {
    const action = args[0];
    if (!['install', 'uninstall', 'status'].includes(action)) die('usage: hooks <install|uninstall|status>');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const hooksScript = path.join(__dirname, 'hooks.mjs');
    const wanted = HOOK_EVENTS;
    let settings;
    const settingsExisted = fs.existsSync(settingsPath);
    if (settingsExisted) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
      catch (e) { die(`${settingsPath} exists but is invalid JSON — fix it manually first (${e.message})`); }
    } else {
      settings = {}; // fresh machine with no user settings yet — start additive from empty
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    }
    settings.hooks = settings.hooks || {};
    const isOurs = hookIsOurs;

    if (action === 'status') {
      const report = {};
      for (const w of wanted) report[w.event] = (settings.hooks[w.event] || []).some(isOurs) ? 'installed' : 'missing';
      return out({ settingsPath, hooksScript, hooks: report });
    }

    const backup = `${settingsPath}.bak-ub-${Date.now()}`;
    if (settingsExisted) fs.copyFileSync(settingsPath, backup);
    let changed = 0;
    if (action === 'install') {
      if (!fs.existsSync(hooksScript)) die(`hooks.mjs not found at ${hooksScript} — run install.mjs first`);
      for (const w of wanted) {
        settings.hooks[w.event] = settings.hooks[w.event] || [];
        if (settings.hooks[w.event].some(isOurs)) continue;
        const group = { hooks: [{ type: 'command', command: `"${process.execPath}" "${hooksScript}" ${w.arg}`, timeout: w.timeout }] };
        if (w.matcher) group.matcher = w.matcher;
        settings.hooks[w.event].push(group);
        changed++;
      }
    } else {
      for (const event of Object.keys(settings.hooks)) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter(g => !isOurs(g));
        changed += before - settings.hooks[event].length;
        if (!settings.hooks[event].length) delete settings.hooks[event];
      }
    }
    if (changed) {
      const tmp = settingsPath + '.tmp-ub';
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
      fs.renameSync(tmp, settingsPath);
    } else if (settingsExisted) fs.unlinkSync(backup);
    out({
      ok: true, action, changed, backup: changed && settingsExisted ? backup : null,
      note: changed ? 'hooks take effect in NEW Claude sessions (already-running sessions loaded hooks at startup)' : 'nothing to change',
    });
  },

  async status() {
    const project = await ensureProject();
    const st = await api('GET', '/api/state');
    const hooks = hooksCoverage();
    out({
      state: st.control.state, session: st.control.session, pausedInfo: st.control.pausedInfo,
      url: await uiLaunchUrl(project.id),
      tasks: summarize(st.tasks),
      schedule: st.schedule ? { waves: st.schedule.waves.length, parallel: st.schedule.parallel } : null,
      jobs: st.jobs.filter(j => ['queued', 'running'].includes(j.state)).map(j => ({ id: j.id, type: j.type, state: j.state, model: j.model })),
      claudeCli: st.server.claudeCli, headlessAuth: st.server.headlessAuth,
      hooks: { installed: hooks.installed, missing: hooks.missing },
      ...(st.server.headlessAuth === 'required' ? { loginCommand: st.server.loginCommand } : {}),
    });
  },
};

async function currentTask(idFragment) {
  if (!idFragment || typeof idFragment !== 'string') die('a task id (or unique id suffix) is required');
  const st = await api('GET', '/api/state');
  const exact = st.tasks.find(x => x.id === idFragment);
  if (exact) return exact;
  const matches = st.tasks.filter(x => x.id.endsWith(idFragment));
  if (!matches.length) die(`task ${idFragment} not found`);
  if (matches.length > 1) die(`ambiguous id suffix ${idFragment}`, { matches: matches.map(m => ({ id: m.id, title: m.title })) });
  return matches[0];
}
async function fullId(idFragment) { return (await currentTask(idFragment)).id; }

function summarize(tasks) {
  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return { total: tasks.length, ...counts };
}

// Which UB hook entries this app expects in ~/.claude/settings.json. Shared by the
// `hooks` verb (install/status) and passively surfaced in `status`/`ensure`.
const HOOK_EVENTS = [
  { event: 'SessionStart', arg: 'session-start', timeout: 8 },
  { event: 'Stop', arg: 'stop', timeout: 8 },
  { event: 'PreToolUse', arg: 'pretool-skill', timeout: 5, matcher: 'Skill' },
  { event: 'SubagentStop', arg: 'subagent-stop', timeout: 8 },
  { event: 'PreCompact', arg: 'pre-compact', timeout: 5 },
  { event: 'PostToolUse', arg: 'post-tool', timeout: 5 },
  { event: 'SessionEnd', arg: 'session-end', timeout: 8 },
];
// marker must match both install locations: ~/.claude/unfinished-business/ and the "Unfinished Business" dev repo
const hookIsOurs = g => (g.hooks || []).some(h => /unfinished[ -]business/i.test(String(h.command || '')) && String(h.command || '').includes('hooks.mjs'));
function hooksCoverage() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return { installed: [], missing: HOOK_EVENTS.map(w => w.event), settingsReadable: false }; }
  const installed = [], missing = [];
  for (const w of HOOK_EVENTS) ((settings.hooks?.[w.event] || []).some(hookIsOurs) ? installed : missing).push(w.event);
  return { installed, missing, settingsReadable: true };
}

// ---------------------------------------------------------------- run
if (!verb || !verbs[verb]) { console.log(HELP); process.exit(verb ? 1 : 0); }
verbs[verb]().catch(e => die(String(e.message || e)));
