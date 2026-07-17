#!/usr/bin/env node
// Unfinished Business — MCP stdio bridge.
// Line-delimited JSON-RPC 2.0 implementing the MCP tool surface, so Claude can
// capture and work the queue through native tools instead of Bash one-liners.
// Register per project via: node ub.mjs mcp print-config [--write-project <path>]
//
// The bridge holds no state: it resolves the project from cwd (or --project),
// boots the durable server if needed, and forwards over loopback HTTP.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coerceLoopbackPort } from './security.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'UnfinishedBusiness');
const SERVER_JSON = path.join(ROOT, 'server.json');
const VERSION = '2.0.0';

const argFlags = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) argFlags[process.argv[i].slice(2)] = process.argv[i + 1];
}
const projectPath = path.resolve(argFlags.project || process.cwd());

// ------------------------------------------------------------- server access
function serverInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVER_JSON, 'utf8'));
    const port = coerceLoopbackPort(info.port);
    return port ? { ...info, port } : null;
  } catch { return null; }
}
async function health(info) {
  if (!info?.port) return false;
  try { return (await (await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(2000) })).json()).ok === true; }
  catch { return false; }
}
let _info = null, _projectId = null;
async function ensureServer() {
  let info = serverInfo();
  if (await health(info)) return info;
  const child = spawn(process.execPath, [path.join(__dirname, 'ub-server.mjs')], { detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    info = serverInfo();
    if (await health(info)) return info;
  }
  throw new Error('Unfinished Business server failed to start');
}
async function api(method, route, body, query = {}) {
  if (!_info) _info = await ensureServer();
  if (!_projectId) {
    const { project } = await rawApi('POST', '/api/projects', { path: projectPath }, {});
    _projectId = project.id;
  }
  return rawApi(method, route, body, { project: _projectId, ...query });
}
async function rawApi(method, route, body, query) {
  const q = new URLSearchParams(query);
  const headers = { 'X-UB-Token': _info.cliToken, 'Content-Type': 'application/json' };
  // same heartbeat contract as the CLI: identify the calling session
  if (process.env.CLAUDE_CODE_SESSION_ID) headers['X-UB-Session'] = process.env.CLAUDE_CODE_SESSION_ID;
  const res = await fetch(`http://127.0.0.1:${_info.port}${route}${q.size ? '?' + q : ''}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function uiLaunchUrl() {
  const { nonce } = await api('POST', '/api/ui-launch', {});
  return `http://127.0.0.1:${_info.port}/?project=${encodeURIComponent(_projectId)}#launch=${encodeURIComponent(nonce)}`;
}
async function task(idFragment) {
  const st = await api('GET', '/api/state');
  const exact = st.tasks.find(t => t.id === idFragment);
  if (exact) return exact;
  const m = st.tasks.filter(t => t.id.endsWith(idFragment));
  if (m.length !== 1) throw new Error(m.length ? `ambiguous id ${idFragment}` : `task ${idFragment} not found`);
  return m[0];
}

function dedupeKeyFor(title, context, sessionId) {
  return crypto.createHash('sha256').update(`${title}\0${context || ''}\0${sessionId || ''}`).digest('hex').slice(0, 16);
}
// Mirror of the CLI offline outbox: never lose a capture to a down server.
function spoolTaskOffline(body, dedupeKey, sessionId) {
  const dir = path.join(ROOT, 'spool', '_tasks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.json`);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ kind: 'task', payload: body, projectPath, dedupeKey, sessionId, ts: new Date().toISOString() }));
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------- tool surface
const TOOLS = [
  {
    name: 'ub_status',
    description: 'Current Unfinished Business queue state for this project: control state, task counts, running jobs, blockers, UI URL.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const st = await api('GET', '/api/state');
      const counts = {};
      for (const t of st.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
      return {
        state: st.control.state, tasks: counts,
        jobs: st.jobs.filter(j => ['queued', 'running'].includes(j.state)).map(j => ({ type: j.type, state: j.state })),
        candidatesAwaitingTriage: st.candidates.count,
        url: await uiLaunchUrl(),
        headlessAuth: st.server.headlessAuth,
      };
    },
  },
  {
    name: 'ub_add_task',
    description: 'Capture a task into the durable queue. Use the moment ANY unfinished-work candidate is identified (todo, bug, follow-up, discussion commitment, out-of-scope discovery) — capture before judgment.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'plain-English task name' },
        instructions: { type: 'string' },
        context: { type: 'string', description: 'where this came from / why it exists' },
        size: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        priority: { type: 'number', minimum: 1, maximum: 5 },
        prep: { type: 'string', enum: ['off', 'quick', 'full'], description: 'preparation mode (separate planning session)' },
        fromOperator: { type: 'boolean', description: 'true when relaying a task the operator dictated' },
        sourceKind: { type: 'string', description: 'when mirroring an external tracker: its kind (gsd/github/jira/doc)' },
        sourceRef: { type: 'string', description: 'stable external id — re-importing the same ref dedupes instead of duplicating' },
        sourceUrl: { type: 'string', description: 'optional deep link to the external item' },
      },
      required: ['title'],
    },
    async run(a) {
      const sessionId = process.env.CLAUDE_CODE_SESSION_ID || '';
      const dedupeKey = dedupeKeyFor(a.title, a.context, sessionId);
      const body = {
        title: a.title, instructions: a.instructions || '', size: a.size, risk: a.risk, priority: a.priority,
        prep: { mode: a.prep, auto: a.prep !== 'off', model: 'adaptive' },
        source: { context: a.context || '' },
        authorKind: a.fromOperator ? 'operator' : undefined,
        authorDetail: a.fromOperator ? 'dictated to Claude' : 'mcp',
        dedupeKey,
        linkedSource: a.sourceRef ? { kind: a.sourceKind || '', ref: a.sourceRef, url: a.sourceUrl || '' } : undefined,
      };
      try {
        const r = await api('POST', '/api/tasks', body);
        return { id: r.task.id, title: r.task.title, status: r.task.status, prep: r.task.prep.state, ...(r.duplicate ? { duplicate: true } : {}) };
      } catch (e) {
        // spool on network-level failure only; a real 4xx must surface
        if (!/fetch failed|network|ECONNREFUSED|failed to start|timeout|aborted/i.test(String(e.message))) throw e;
        spoolTaskOffline(body, dedupeKey, sessionId);
        return { captured: 'offline', willSync: true, note: 'server unreachable — captured to the offline outbox; it syncs automatically. Retrying is safe (deduped).' };
      }
    },
  },
  {
    name: 'ub_next',
    description: 'Get the next thing the work loop should do: a operator directive (pause/note), the next ready task (with plan + subtasks), a waiting notice, or queue-empty with review/blocked lists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() { return api('GET', '/api/next'); },
  },
  {
    name: 'ub_update_task',
    description: 'Update a task: status (in_progress when starting execution, ready, blocked...), engine, instructions, or attach a prepared plan.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['inbox', 'preparing', 'ready', 'in_progress', 'blocked', 'awaiting_operator', 'review'] },
        engine: { type: 'string', enum: ['auto', 'gsd-fast', 'gsd-quick', 'gsd-execute-phase', 'gsd-debug', 'rigorous', 'rigorous-lite', 'direct'] },
        instructions: { type: 'string' },
        plan: { type: 'string', description: 'execution plan markdown (marks prep ready)' },
        subtaskDone: { type: 'string', description: 'subtask id (or suffix) to mark done' },
        subtaskSkip: { type: 'string', description: 'subtask id (or suffix) to mark skipped — use when a subtask is not applicable so it stops blocking completion' },
      },
      required: ['id'],
    },
    async run(a) {
      const t = await task(a.id);
      const patch = {};
      if (a.status) patch.status = a.status;
      if (a.engine) patch.engine = a.engine;
      if (a.instructions !== undefined) patch.instructions = a.instructions;
      if (a.plan !== undefined) { patch.prep = { plan: a.plan, state: 'ready' }; if (!a.status && ['inbox', 'preparing'].includes(t.status)) patch.status = 'ready'; }
      if (a.subtaskDone || a.subtaskSkip) {
        let subs = t.subtasks;
        const apply = (frag, status) => {
          const m = subs.filter(s => s.id === frag || s.id.endsWith(frag));
          if (m.length !== 1) throw new Error(m.length ? `ambiguous subtask id ${frag}` : `subtask not found: ${frag}`);
          subs = subs.map(s => s.id === m[0].id ? { ...s, status } : s);
        };
        if (a.subtaskDone) apply(a.subtaskDone, 'done');
        if (a.subtaskSkip) apply(a.subtaskSkip, 'skipped');
        patch.subtasks = subs;
      }
      const r = await api('PATCH', '/api/tasks', { expectedRevision: t.revision, patch }, { id: t.id });
      return { id: r.task.id, status: r.task.status, revision: r.task.revision };
    },
  },
  {
    name: 'ub_complete_task',
    description: 'Mark a task done. Gated server-side: requires concrete verification evidence (what was checked, how, result), ALL subtasks done or skipped (use ub_update_task subtaskSkip for N/A ones), and verification not in a "failed" state. A reopened task needs FRESH evidence to re-close. Run a residual sweep first — capture every discovery as a new task before completing.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, evidence: { type: 'string', minLength: 20 } },
      required: ['id', 'evidence'],
    },
    async run(a) {
      if (!a.evidence || a.evidence.trim().length < 20) throw new Error('evidence must describe what was verified, how, and the result (min 20 meaningful chars)');
      const t = await task(a.id);
      const r = await api('PATCH', '/api/tasks', {
        expectedRevision: t.revision,
        patch: { verification: { state: 'passed', evidence: a.evidence }, status: 'done' },
      }, { id: t.id });
      return { id: r.task.id, status: r.task.status };
    },
  },
  {
    name: 'ub_block_task',
    description: 'Mark a task blocked with a reason. Set needsOperator when only the operator can unblock it (decision, approval, credentials). Then take the next task — never stall the loop.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, reason: { type: 'string' }, needsOperator: { type: 'boolean' } },
      required: ['id', 'reason'],
    },
    async run(a) {
      const t = await task(a.id);
      const r = await api('PATCH', '/api/tasks', {
        expectedRevision: t.revision,
        patch: { status: a.needsOperator ? 'awaiting_operator' : 'blocked', blockedReason: a.reason },
      }, { id: t.id });
      return { id: r.task.id, status: r.task.status };
    },
  },
  {
    name: 'ub_note',
    description: 'Queue a note into the work loop (delivered at the next task boundary). For relaying operator messages.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
    async run(a) { await api('POST', '/api/notes', { text: a.text }); return { ok: true }; },
  },
  {
    name: 'ub_ask',
    description: 'Ask a side question — a separate agent session (read-only codebase + web research) answers it without interrupting the current execution loop. The answer arrives asynchronously in the UI Side-questions panel. Use to research something in parallel.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        question: { type: 'string', description: 'the question to investigate' },
        model: { type: 'string', enum: ['adaptive', 'haiku', 'sonnet', 'opus'], description: 'model for the answering agent (default adaptive → sonnet)' },
      },
      required: ['question'],
    },
    async run(a) {
      const r = await api('POST', '/api/questions', { question: a.question, model: a.model });
      return { id: r.question.id, job: r.job.id, note: 'question dispatched — answer arrives asynchronously' };
    },
  },
];

// ------------------------------------------------------------- JSON-RPC loop
function reply(id, result, error) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = error; else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async line => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch { return reply(null, undefined, { code: -32700, message: 'parse error' }); }
  if (Array.isArray(req)) return reply(null, undefined, { code: -32600, message: 'batch requests are not supported' });
  const { id, method, params } = req;
  const isRequest = id !== undefined; // id-less messages are notifications — never respond
  try {
    if (method === 'initialize') {
      if (isRequest) reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'unfinished-business', version: VERSION },
      });
    } else if (method?.startsWith('notifications/')) {
      // notifications get no response
    } else if (method === 'ping') {
      if (isRequest) reply(id, {});
    } else if (method === 'tools/list') {
      if (isRequest) reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    } else if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params?.name);
      if (!tool) { if (isRequest) reply(id, undefined, { code: -32602, message: `unknown tool ${params?.name}` }); return; }
      try {
        const result = await tool.run(params.arguments || {});
        if (isRequest) reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        if (isRequest) reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    } else if (isRequest) {
      reply(id, undefined, { code: -32601, message: `method not found: ${method}` });
    }
  } catch (e) {
    if (isRequest) reply(id, undefined, { code: -32603, message: String(e.message || e) });
  }
});
rl.on('close', () => process.exit(0));
