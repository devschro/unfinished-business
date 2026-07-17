/* Unfinished Business UI — vanilla JS, no build step. */
'use strict';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let PROJECT = null, STATE = null, es = null, pollTimer = null;
let inspectorTaskId = null;

// ---------------------------------------------------------------- api
async function api(method, route, body, query = {}) {
  const q = new URLSearchParams({ project: PROJECT, ...query });
  const res = await fetch(`${route}?${q}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 409) { toast(data.error || 'Conflict — refreshed'); await refresh(); }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, ms);
}

// Toast with a single inline action button (e.g. Undo). The action's own toast
// (or error) replaces this one when clicked.
function toastAction(msg, label, fn, ms = 6000) {
  const t = $('#toast');
  t.textContent = msg + '  ';
  const b = document.createElement('button');
  b.className = 'btn subtle'; b.textContent = label; b.style.marginLeft = '8px';
  b.onclick = async () => { clearTimeout(t._h); t.style.display = 'none'; try { await fn(); } catch (e) { toast(e.message || String(e)); } };
  t.appendChild(b);
  t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, ms);
}

// ---------------------------------------------------------------- boot
async function boot() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const nonce = fragment.get('launch');
  // Remove the one-use ticket from browser history before making any requests.
  if (nonce) history.replaceState(null, '', location.pathname + location.search);
  const bootstrap = await fetch('/api/bootstrap', nonce ? {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  } : { credentials: 'same-origin' });
  const bs = await bootstrap.json().catch(() => ({}));
  if (!bootstrap.ok) throw new Error(bs.error || 'Open the fresh UI URL printed by `ub ensure`.');
  const urlProject = new URLSearchParams(location.search).get('project');
  const known = bs.projects || [];
  if (urlProject && known.some(p => p.id === urlProject)) {
    PROJECT = urlProject;
  } else if (known.length === 1) {
    PROJECT = known[0].id;
    history.replaceState(null, '', `/?project=${PROJECT}`);
  } else {
    return showPicker(known);
  }
  connect();
  await refresh();
  wireControls();
}

function showPicker(projects) {
  const p = $('#picker');
  p.style.display = 'flex';
  p.innerHTML = `<h1 style="font-size:26px">◔ Unfinished Business</h1>
    <p style="color:var(--muted)">${projects.length ? 'Pick a project' : 'No projects yet — run <code>/unfinished-business</code> in Claude Code first.'}</p>` +
    projects.map(pr => `<button class="btn proj" data-id="${esc(pr.id)}"><strong>${esc(pr.name)}</strong></button>`).join('');
  p.querySelectorAll('.proj').forEach(b => b.onclick = () => { location.href = `/?project=${b.dataset.id}`; });
}

function connect() {
  if (es) es.close();
  es = new EventSource(`/api/events?project=${PROJECT}`);
  let t = null;
  es.onmessage = () => { clearTimeout(t); t = setTimeout(refresh, 150); };
  es.onerror = () => { $('#conn-dot').className = 'dot off'; };
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 15000); // safety net
}

async function refresh() {
  if (es && es.readyState === EventSource.CLOSED) connect(); // self-heal a dropped stream
  try {
    STATE = await api('GET', '/api/state');
    render();
  } catch (e) {
    $('#conn-dot').className = 'dot off';
    $('#state-label').textContent = 'server unreachable';
  }
}

// ---------------------------------------------------------------- render
function render() {
  const s = STATE;
  $('#project-name').textContent = s.project.name;
  document.title = `◔ ${s.project.name} — Unfinished Business`;
  const stateName = s.control.state;
  const sseDown = es && es.readyState === EventSource.CLOSED;
  $('#conn-dot').className = 'dot ' + (sseDown ? 'off' : stateName === 'running' ? 'on' : stateName === 'paused' || stateName === 'pause_requested' ? 'paused' : '');
  let seen = '';
  if (stateName === 'running' && s.control.session?.lastSeen) {
    const m = Math.round((Date.now() - Date.parse(s.control.session.lastSeen)) / 60000);
    seen = m >= 1 ? ` · seen ${m}m ago` : ' · active now';
  }
  $('#state-label').textContent = (sseDown ? 'reconnecting… · ' : '') + (({ running: 'Claude is working', pause_requested: 'pausing at next safe point…', paused: 'paused', idle: 'idle — no active session' })[stateName] || stateName) + seen;

  const hc = $('#hooks-chip');
  if (hc) {
    if (s.server?.hooksInstalled === false) {
      hc.style.display = ''; hc.textContent = '⚠ enforcement hooks off';
      hc.title = 'UB stop-guard / capture hooks are not installed in ~/.claude/settings.json — the non-stop guard is inactive. Run `ub hooks install` (takes effect in new sessions).';
    } else hc.style.display = 'none';
  }

  renderSafeMode(s);
  renderPauseBanner(s);
  renderPendingSchedule(s);
  renderJobs(s);
  renderDirectives(s);
  renderCandidates(s);
  renderQuestions(s);
  renderLanes(s);
  renderHQ(s);
  applySearchFilter();
  directAgent(s);
  const pv = $('#preview-toggle');
  if (document.activeElement !== pv) pv.checked = s.control.settings?.autoApplySchedule === false;
  $('#undo-order-btn').style.display = s.scheduleHistory > 0 ? '' : 'none';
  $('#pause-btn').textContent = stateName === 'pause_requested' ? 'Cancel pause' : 'Pause safely';
  $('#pause-btn').disabled = stateName === 'paused';
  const fib = $('#force-idle-btn');
  if (fib) fib.style.display = (stateName === 'running' || stateName === 'pause_requested') ? '' : 'none';
  if (inspectorTaskId) renderInspector(inspectorTaskId, true);
}

// ------------------------------------------------------------ HQ hero
function renderHQ(s) {
  const tasks = s.tasks;
  const open = tasks.filter(t => !['done', 'archived'].includes(t.status));
  const needs = open.filter(t => ['awaiting_operator', 'blocked'].includes(t.status));
  const today = new Date().toISOString().slice(0, 10);
  const closedToday = tasks.filter(t => t.status === 'done' && (t.updatedAt || '').startsWith(today));
  $('#stat-open').textContent = open.length;
  $('#stat-needs').textContent = needs.length;
  $('#stat-closed').textContent = closedToday.length;
  $('#stat-needs').parentElement.style.opacity = needs.length ? 1 : .55;
  updateAttention(needs.length, s.project.name);

  const active = tasks.filter(t => t.status === 'in_progress');
  const caseTile = $('#hq-case'), idleTile = $('#hq-idle');
  if (active.length) {
    const t = active[0];
    const done = t.subtasks.filter(x => x.status !== 'open').length;
    const cur = t.subtasks.find(x => x.status === 'open');
    caseTile.style.display = ''; idleTile.style.display = 'none';
    $('#case-title').textContent = t.title;
    $('#case-fill').style.width = (t.subtasks.length ? Math.round(done / t.subtasks.length * 100) : 8) + '%';
    $('#case-sub').textContent = (cur ? `▸ ${cur.title}` : t.subtasks.length ? 'wrapping up' : 'in progress')
      + (active.length > 1 ? `  (+${active.length - 1} more)` : '');
    caseTile.onclick = () => openInspector(t.id);
  } else {
    caseTile.style.display = 'none'; idleTile.style.display = '';
    idleTile.querySelector('.idle-line').textContent =
      needs.length ? 'Waiting on you.' : open.length ? 'Between tasks.' : 'No tasks running.';
    idleTile.querySelector('.tile-foot').textContent =
      needs.length ? 'Reply below to unblock.' : open.length ? 'The queue has tasks ready.' : 'Nothing queued yet.';
  }
}

// Out-of-page attention: the tab is usually backgrounded, so surface needs-operator
// in the title (and a one-shot OS notification on a 0→N edge, throttled + permission-
// gated) instead of only an in-page pulse the operator can't see.
let prevNeeds = null, lastNotify = 0;
function updateAttention(needsCount, projectName) {
  document.title = (needsCount ? `(${needsCount}) ` : '') + `◔ ${projectName} — Unfinished Business`;
  if (prevNeeds !== null && prevNeeds === 0 && needsCount > 0 && Date.now() - lastNotify > 60_000) {
    lastNotify = Date.now();
    if ('Notification' in window) {
      if (Notification.permission === 'granted') { try { new Notification(`Unfinished Business — ${projectName}`, { body: `${needsCount} task(s) need your attention.` }); } catch {} }
      else if (Notification.permission !== 'denied') Notification.requestPermission().catch(() => {}); // ask once; the next 0→N edge notifies
    }
  }
  prevNeeds = needsCount;
}

// --------------------------------------------------------- queue agent
// Translate live queue state into the orchestration map's mode signals.
let prevDoneCount = null, captionHoldUntil = 0;
const CAPTIONS = { working: 'Working', idle: 'Idle', paused: 'Paused', needsYou: 'Needs your attention' };

function setCaption(text, cls = '', holdMs = 0) {
  const cap = $('#agent-caption');
  if (!cap) return;
  if (holdMs) captionHoldUntil = Date.now() + holdMs;
  else if (Date.now() < captionHoldUntil) return;
  cap.textContent = text;
  cap.className = cls;
}

function directAgent(s) {
  if (!window.QueueAgent) return;
  const tasks = s.tasks;
  const doneCount = tasks.filter(t => t.status === 'done').length;
  if (prevDoneCount !== null && doneCount > prevDoneCount) {
    window.QueueAgent.celebrate();
    setCaption('Done', 'done', 12_000);
  }
  prevDoneCount = doneCount;

  const stateName = s.control.state;
  const needsYou = tasks.some(t => t.status === 'awaiting_operator');
  const working = stateName === 'running' && tasks.some(t => t.status === 'in_progress');
  const mode = (stateName === 'paused' || stateName === 'pause_requested') ? 'paused'
    : needsYou ? 'needsYou'
    : working ? 'working'
    : 'idle';
  setCaption(CAPTIONS[mode] || mode, mode === 'needsYou' ? 'attn' : '');
  window.QueueAgent.setMode(mode, {
    inspectorOpen: !!inspectorTaskId,
    prepRunning: (s.jobs || []).some(j => j.type === 'prepare' && j.state === 'running'),
    councilRunning: (s.jobs || []).some(j => j.type === 'council' && j.state === 'running'),
    questionRunning: (s.jobs || []).some(j => j.type === 'question' && j.state === 'running'),
  });
}

// ------------------------------------------------------------ search filter
function applySearchFilter() {
  const q = ($('#search')?.value || '').trim().toLowerCase();
  document.querySelectorAll('.task').forEach(el => {
    const hit = !q || el.textContent.toLowerCase().includes(q);
    el.classList.toggle('filtered-out', !hit);
  });
}

// SAFE MODE / audit-broken banner — the store could not be parsed and writes are
// paused, or the audit chain hit a write error. Both need operator attention.
function renderSafeMode(s) {
  let el = $('#safemode-banner');
  if (!el) { el = document.createElement('div'); el.id = 'safemode-banner'; el.style.display = 'none'; $('#pause-banner').before(el); }
  if (s.degraded) {
    el.className = 'safemode';
    el.innerHTML = `<h3>⛔ Safe mode — store corruption detected</h3>
      <div>A store file for this project could not be parsed. Writes are paused so the recoverable data isn't overwritten; the corrupt file is preserved as <code>.corrupt-&lt;ts&gt;</code>. Captured tasks are spooled and will sync after recovery.</div>
      <div class="insp-actions"><button class="btn primary" id="recover-btn">I've reconciled the store — recover</button></div>`;
    el.style.display = '';
    $('#recover-btn').onclick = async () => {
      if (!confirm('Clear safe mode? Do this only after reconciling or restoring the store — otherwise in-memory state (possibly empty) will overwrite disk.')) return;
      try { await api('POST', '/api/recover', { acknowledge: true }); toast('Recovered — writes resumed'); } catch (e) { toast(e.message); }
    };
  } else if (s.auditBroken) {
    el.className = 'safemode warn';
    el.innerHTML = `<h3>⚠ Audit log write error</h3><div>The audit chain hit a write failure; the last event was dropped rather than fork the chain. Check disk space/permissions. Run <code>ub verify-audit</code>.</div>`;
    el.style.display = '';
  } else el.style.display = 'none';
}

function renderPauseBanner(s) {
  const el = $('#pause-banner');
  if (s.control.state === 'paused') {
    const info = s.control.pausedInfo || {};
    const steps = info.resumeSteps || ['/clear', '/unfinished-business continue'];
    el.innerHTML = `<h3>⏸ Paused — context saved${info.method === 'gsd-pause-work' ? ' via /gsd-pause-work' : ''}</h3>
      <div style="color:var(--muted);font-size:13px">${esc(info.note || 'The work loop stopped at a safe point. To reset the context window and continue exactly where it left off, run these in the Claude session:')}</div>
      <ol>${steps.map(cmd => `<li class="copy-line"><code>${esc(cmd)}</code><button class="btn subtle" data-copy="${esc(cmd)}">copy</button></li>`).join('')}</ol>
      <div style="color:var(--muted);font-size:12px">This page stays live — it will switch back to “working” automatically when the new session re-registers.</div>`;
    el.style.display = '';
    el.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); });
  } else if (s.control.state === 'pause_requested') {
    el.innerHTML = `<h3>⏳ Pausing…</h3><div style="color:var(--muted)">Claude will finish the current atomic step, save a handoff, and confirm here.</div>`;
    el.style.display = '';
  } else el.style.display = 'none';
}

function renderPendingSchedule(s) {
  const el = $('#pending-schedule');
  const p = s.pendingSchedule;
  if (!p) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `<h3>Proposed order — ${p.waves.length} wave(s)${p.parallel ? ' · parallel' : ''}</h3>` +
    p.waves.map((w, i) => `<div class="wave-line">Wave ${i + 1}: ${w.taskIds.map(id => esc(taskById(id)?.title || id)).join(' · ')}${w.rationale ? ` — <em>${esc(w.rationale)}</em>` : ''}</div>`).join('') +
    (p.warnings?.length ? `<div class="wave-line" style="color:var(--warn)">⚠ ${p.warnings.map(esc).join(' · ')}</div>` : '') +
    `<div class="insp-actions"><button class="btn primary" id="sched-apply">Apply this order</button><button class="btn subtle" id="sched-discard">Discard</button></div>`;
  $('#sched-apply').onclick = async () => { try { await api('POST', '/api/schedule/apply'); toast('Order applied'); } catch (e) { toast(e.message); } };
  $('#sched-discard').onclick = async () => { try { await api('POST', '/api/schedule/discard'); toast('Proposal discarded'); } catch (e) { toast(e.message); } };
}

function renderCandidates(s) {
  const el = $('#candidates');
  const c = s.candidates;
  if (!c?.count && !c?.archivedUnseen) { el.style.display = 'none'; return; }
  const wasCollapsed = el.classList.contains('collapsed');
  el.style.display = '';
  const archNote = c.archivedUnseen
    ? `<button class="btn subtle" id="cand-archive-view" title="Signals that overflowed the cap were archived to disk, not lost">${c.archivedUnseen} archived ▸</button>` : '';
  el.innerHTML = `<h3>Captured signals (${c.count}) — from hooks, awaiting your triage ▾ ${archNote}</h3><div class="cand-body">` +
    c.items.map(x => `<div class="cand-row">
      <span class="kind">${x.kind === 'subagent' ? '⚙ subagent' : x.kind === 'compact' ? '≋ compact' : '• signal'}</span>
      <span class="summary" title="${esc(x.summary)}">${esc(x.summary)}</span>
      <button class="btn" data-promote="${esc(x.id)}" aria-label="Create a task from this signal">Make task</button>
      <button class="btn subtle" data-dismiss="${esc(x.id)}" aria-label="Dismiss this signal">Dismiss</button>
    </div>`).join('') + '</div>';
  if (wasCollapsed) el.classList.add('collapsed');
  el.querySelector('h3').onclick = () => el.classList.toggle('collapsed');
  const av = $('#cand-archive-view');
  if (av) av.onclick = async (e) => {
    e.stopPropagation();
    try { const r = await api('GET', '/api/candidates/archive'); toast(`${r.total} signal(s) archived to candidates-archive.jsonl (kept on disk, never lost).`); await refresh(); }
    catch (err) { toast(err.message); }
  };
  el.querySelectorAll('[data-promote]').forEach(b => b.onclick = async () => {
    try { const r = await api('POST', '/api/candidates/promote', { id: b.dataset.promote }); toast(`Task created: ${r.task.title.slice(0, 60)}`); } catch (e) { toast(e.message); }
  });
  el.querySelectorAll('[data-dismiss]').forEach(b => b.onclick = async () => {
    const id = b.dataset.dismiss;
    try {
      await api('POST', '/api/candidates/dismiss', { id, reason: 'dismissed from UI' });
      toastAction('Signal dismissed', 'Undo', async () => { await api('POST', '/api/candidates/undismiss', { id }); toast('Dismissal undone'); });
    } catch (e) { toast(e.message); }
  });
}

// Queued operator directives (notes) with per-item delivery state + cancel. A note
// keeps showing until the loop has acted on it — the operator can always see and
// (if not yet delivered) cancel what is waiting.
function renderDirectives(s) {
  const el = $('#directives-strip');
  const ds = s.control?.directives || [];
  if (!ds.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `<span class="dir-label">Notes queued for Claude:</span>` + ds.map(d =>
    `<span class="dir-chip${d.delivered ? ' delivered' : ''}" title="${esc(d.text)}">${esc(d.text.slice(0, 70))}${d.delivered ? ' <em>· delivered</em>' : `<button class="dir-x" data-cancel="${esc(d.id)}" title="Cancel this note">✕</button>`}</span>`).join('');
  el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    try { await api('DELETE', '/api/notes', undefined, { id: b.dataset.cancel }); toast('Note cancelled'); }
    catch (e) { toast(e.message); }
  });
}

function renderJobs(s) {
  const active = (s.jobs || []).filter(j => ['queued', 'running'].includes(j.state));
  const failed = (s.jobs || []).filter(j => j.state === 'failed').slice(0, 3);
  const authNeeded = s.server?.headlessAuth === 'required';
  const el = $('#jobs-strip');
  if (!active.length && !failed.length && !authNeeded) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = (authNeeded ? `<span class="job-chip" style="color:var(--warn)">⚠ Planning sessions need a one-time login — run <code>${esc(s.server.loginCommand)}</code> in any terminal. Until then, Claude prepares tasks in its own session.</span>` : '') + active.map(j => {
    const t = j.type === 'prepare' ? taskById(j.params?.taskId)?.title || 'task'
      : j.type === 'question' ? 'side question'
      : j.type === 'council' ? 'council'
      : 'queue ordering';
    return `<span class="job-chip"><span class="spin">◌</span> ${j.state === 'queued' ? 'queued' : 'session'}: ${esc(t)}${j.model ? ` · ${esc(j.model)}` : ''}</span>`;
  }).join('') + failed.map(j =>
    `<span class="job-chip" style="color:var(--bad)" title="${esc(j.error || '')}">✕ ${esc(j.type)} failed</span>`).join('');
}

function renderQuestions(s) {
  const qs = s.questions || [];
  const askBtn = $('#ask-btn');
  const running = qs.some(q => ['queued', 'running'].includes(q.state));
  if (askBtn) {
    askBtn.innerHTML = '? Ask' + (qs.length ? ` <span class="ask-badge">${qs.length}</span>` : '');
    askBtn.classList.toggle('has-activity', running);
  }
  const el = $('#questions-list');
  if (!el) return;
  if (!qs.length) { el.innerHTML = `<div class="qd-empty">No questions yet. Ask one above — a separate session answers it while your work keeps running.</div>`; return; }
  el.innerHTML = qs.map((q, idx) => {
    const stateChip = q.state === 'done' ? ''
      : q.state === 'failed' ? `<span class="chip" style="color:var(--bad)">failed</span>`
      : `<span class="chip prep-running"><span class="spin">◌</span> ${esc(q.state)}</span>`;
    const badge = `<span class="badge ${q.askedBy === 'operator' ? 'operator' : 'claude'}">${q.askedBy === 'operator' ? 'You' : 'Claude'}</span>`;
    return `<div class="question-row">
      <div class="q-header">${badge}${stateChip}<span class="q-model">${esc(q.model)}</span><span class="q-time">${esc((q.createdAt || '').slice(11, 16))}</span></div>
      <div class="q-text">${esc(q.question)}</div>
      ${q.answer ? `<details ${q.state === 'done' && idx === 0 ? 'open' : ''}><summary>Answer</summary><div class="q-answer">${esc(q.answer)}</div>
        ${q.references?.length ? `<div class="q-refs">${q.references.map(r => `<code>${esc(r)}</code>`).join(' ')}</div>` : ''}</details>` : ''}
      ${q.error ? `<div class="q-error">Error: ${esc(q.error)}</div>` : ''}
    </div>`;
  }).join('');
}

function taskById(id) { return STATE?.tasks.find(t => t.id === id); }

// Unknown/legacy author kinds must never silently masquerade as Claude
// (that is exactly what happened during the boss→operator transition window)
function badgeFor(t) {
  const k = t.author.kind;
  const label = k === 'claude' ? 'Claude' : k === 'operator' ? 'Operator' : k.charAt(0).toUpperCase() + k.slice(1);
  return `<span class="badge ${k === 'claude' ? 'claude' : 'operator'}" title="${esc(k)} · ${esc(t.author.detail || '')}">${esc(label)}</span>`;
}

function taskRow(t, extra = '') {
  const prep = ['queued', 'running'].includes(t.prep.state) ? `<span class="chip prep-${t.prep.state}">◔ planning${t.prep.state === 'queued' ? ' (queued)' : ''}</span>`
    : t.prep.state === 'failed' ? `<span class="chip prep-failed">plan failed</span>`
    : t.prep.state === 'ready' && t.status !== 'done' ? `<span class="chip">plan ✓</span>` : '';
  const doneSt = t.subtasks.filter(x => x.status !== 'open').length;
  const currentSt = t.subtasks.find(x => x.status === 'open');
  const subs = t.subtasks.length
    ? `<span class="chip chips-extra">${doneSt}/${t.subtasks.length}${currentSt && (doneSt > 0 || t.status === 'in_progress') ? ' · ▸ ' + esc(currentSt.title.slice(0, 40)) : ' subtasks'}</span>` : '';
  const risk = t.risk === 'high' ? `<span class="chip risk-high">high risk</span>` : '';
  const status = ['in_progress', 'blocked', 'awaiting_operator', 'review'].includes(t.status) ? `<span class="chip status-${t.status}">${t.status.replace('_', ' ')}</span>` : '';
  const sla = t.slaFlag ? `<span class="chip risk-high" title="Waiting on you for ${t.slaFlag}h+">⏳ ${t.slaFlag}h</span>` : '';
  const msg = t.status === 'awaiting_operator' && t.blockedReason
    ? `<span class="task-msg" title="${esc(t.blockedReason)}">💬 ${esc(t.blockedReason.split('\n')[0])}</span>` : '';
  if (t.status === 'done' || t.status === 'archived') {
    return `<div class="task done-row" data-id="${esc(t.id)}">
      ${badgeFor(t)}<span class="title">${esc(t.title)}</span><span class="case-no">${caseNo(t)}</span>
    </div>`;
  }
  return `<div class="task" data-id="${esc(t.id)}" data-pri="${t.priority}">
    <div class="task-main"><span class="case-no">${caseNo(t)}</span><span class="title">${esc(t.title)}</span><span class="task-age" title="last updated">${relTime(t.updatedAt || t.createdAt)}</span></div>
    <div class="task-meta">${badgeFor(t)}${msg}${status}${sla}${prep}${subs}${risk}${extra}</div>
  </div>`;
}

function caseNo(t) { return '#' + t.id.slice(-6).toUpperCase(); }

function relTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60; if (m < 90) return `${Math.round(m)}m ago`;
  const h = m / 60; if (h < 36) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Expanded card for the NOW lane: inline subtask checklist + progress bar,
// with the currently-active subtask highlighted.
function taskRowNow(t) {
  const done = t.subtasks.filter(s => s.status !== 'open');
  const current = t.subtasks.find(s => s.status === 'open');
  const progress = t.subtasks.length ? Math.round((done.length / t.subtasks.length) * 100) : 0;
  const orphaned = t.status === 'in_progress' && t.lease && Date.parse(t.lease.expiresAt) < Date.now();
  const status = `<span class="chip status-${t.status}">${t.status.replace('_', ' ')}</span>`
    + (orphaned ? `<span class="chip risk-high" title="The session that claimed this task appears gone — its lease expired. It will auto-return to the queue, or reset it now.">⚠ orphaned</span><button class="mini-btn accent" data-reset="${esc(t.id)}" title="Return this task to the queue now">reset to ready</button>` : '');
  const subtaskHtml = t.subtasks.length ? `<div class="now-subtasks">
      <div class="now-progress-bar"><div class="now-progress-fill" style="width:${progress}%"></div></div>
      <div class="now-progress-label">${done.length}/${t.subtasks.length} subtasks · ${progress}%${current ? ` · working on: <strong>${esc(current.title.slice(0, 70))}</strong>` : ''}</div>
      ${t.subtasks.map(s => `<div class="now-sub ${s.status !== 'open' ? 'done' : ''}${s === current ? ' current' : ''}">
        <span class="now-sub-icon">${s.status !== 'open' ? '✓' : s === current ? '◔' : '○'}</span>
        <span class="now-sub-title">${esc(s.title)}</span>
      </div>`).join('')}
    </div>` : '';
  return `<div class="task task-now" data-id="${esc(t.id)}" data-pri="${t.priority}">
    <div class="task-now-header">
      ${badgeFor(t)}
      <span class="title">${esc(t.title)}</span>
      <span class="case-no">${caseNo(t)}</span>
      ${status}
    </div>
    ${subtaskHtml}
  </div>`;
}

// ---- manual drag-and-drop ordering (Next + Later lanes)
let draggedTaskId = null;

function enableDragDrop() {
  const laneBodies = ['#lane-next .lane-body', '#lane-later .lane-body'].map(s => document.querySelector(s)).filter(Boolean);
  for (const lane of laneBodies) {
    lane.querySelectorAll('.task').forEach(el => {
      el.draggable = true;
      el.addEventListener('dragstart', e => {
        draggedTaskId = el.dataset.id;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        draggedTaskId = null;
        document.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
      });
    });
    // property assignment (not addEventListener): lane bodies persist across
    // renders, so listeners must be idempotent
    lane.ondragover = e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = e.target.closest('.task');
      document.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
      if (target && target.dataset.id !== draggedTaskId) target.classList.add('drag-over');
    };
    lane.ondrop = async e => {
      e.preventDefault();
      const target = e.target.closest('.task');
      if (!target || !draggedTaskId || target.dataset.id === draggedTaskId) return;
      // full visual order across BOTH lanes (Next first), so a Later-lane drop
      // cannot leapfrog the Next lane
      const ids = [...document.querySelectorAll('#lane-next .task, #lane-later .task')].map(el => el.dataset.id);
      const fromIdx = ids.indexOf(draggedTaskId);
      if (fromIdx < 0) return;
      ids.splice(fromIdx, 1);
      ids.splice(ids.indexOf(target.dataset.id), 0, draggedTaskId);
      try {
        await api('POST', '/api/schedule/manual', { taskIds: ids });
        toast('Order updated — Undo is available');
      } catch (err) { toast(err.message); }
    };
  }
}

const laterBtn = t => `<button class="mini-btn" data-later="${esc(t.id)}" title="Snooze this task — out of the loop until you restore it">snooze</button>`;
const reopenBtn = t => `${t.deferUntil ? `<span class="chip" title="Auto-returns to the queue on this date">↩ ${esc(new Date(t.deferUntil).toISOString().slice(0, 10))}</span>` : ''}<button class="mini-btn accent" data-reopen="${esc(t.id)}" title="Restore this task into the queue">restore</button>`;

function renderLanes(s) {
  const tasks = s.tasks;
  const lanes = { now: [], review: [], needs: [], next: [], later: [], cold: [], done: [], archived: [] };
  for (const t of tasks) {
    if (t.status === 'done') lanes.done.push(t);
    else if (t.status === 'archived') lanes.archived.push(t);
    else if (t.deferred) lanes.cold.push(t); // "on ice" — deferred, out of the loop
    else if (t.status === 'in_progress') lanes.now.push(t);
    else if (t.status === 'review') lanes.review.push(t); // the loop's verify queue — its own lane
    else if (t.status === 'awaiting_operator' || t.status === 'blocked') lanes.needs.push(t);
    else lanes.later.push(t); // provisional; schedule pulls into next
  }
  // Next = scheduled order (waves) or default priority order
  let nextHtml = '';
  const sched = s.schedule;
  if (sched && sched.waves?.length) {
    const remaining = new Set(lanes.later.map(t => t.id));
    let waveNo = 0;
    for (const w of sched.waves) {
      const ws = w.taskIds.map(taskById).filter(t => t && remaining.has(t.id));
      if (!ws.length) continue;
      waveNo++;
      const label = sched.parallel && ws.length > 1 ? `Wave ${waveNo} — can run in parallel` : `Wave ${waveNo}`;
      nextHtml += `<div class="wave-label">${label}${w.rationale ? ` · <span class="why">${esc(w.rationale)}</span>` : ''}</div>`;
      nextHtml += ws.map(t => taskRow(t, laterBtn(t))).join('');
      ws.forEach(t => remaining.delete(t.id));
    }
    lanes.later = lanes.later.filter(t => remaining.has(t.id));
  } else {
    const ordered = lanes.later.slice().sort((a, b) => (b.priority - a.priority) || a.createdAt.localeCompare(b.createdAt));
    const top = ordered.slice(0, 5);
    nextHtml = top.map(t => taskRow(t, laterBtn(t))).join('');
    lanes.later = ordered.slice(5);
  }

  setLane('now', lanes.now.map(t => taskRowNow(t)).join(''));
  setLane('review', lanes.review.map(t => taskRow(t, laterBtn(t))).join(''), lanes.review.length);
  setLane('needs', lanes.needs.map(t => taskRow(t, laterBtn(t))).join(''));
  $('#lane-next .lane-body').innerHTML = nextHtml;
  $('#lane-next').classList.toggle('has-items', !!nextHtml);
  setLane('later', lanes.later.map(t => taskRow(t, laterBtn(t))).join(''));
  setLane('cold', lanes.cold.map(t => taskRow(t, reopenBtn(t))).join(''), lanes.cold.length);
  setLane('done', lanes.done.slice().reverse().map(t => taskRow(t)).join(''), lanes.done.length);
  setLane('archived', lanes.archived.map(t => taskRow(t)).join(''), lanes.archived.length);
  $('#empty-state').style.display = tasks.length ? 'none' : '';
  document.querySelectorAll('.task').forEach(el => el.onclick = () => openInspector(el.dataset.id));
  document.querySelectorAll('[data-later]').forEach(b => b.onclick = e => { e.stopPropagation(); setDeferred(b.dataset.later, true); });
  document.querySelectorAll('[data-reopen]').forEach(b => b.onclick = e => { e.stopPropagation(); setDeferred(b.dataset.reopen, false); });
  document.querySelectorAll('[data-reset]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const t = taskById(b.dataset.reset); if (!t) return;
    try { await api('PATCH', '/api/tasks', { expectedRevision: t.revision, patch: { status: 'ready' } }, { id: t.id }); toast('Reset to ready'); }
    catch (err) { toast(err.message); }
  });
  enableDragDrop();
}

async function setDeferred(id, deferred) {
  const t = taskById(id);
  if (!t) return;
  try { await api('PATCH', '/api/tasks', { expectedRevision: t.revision, patch: { deferred } }, { id }); toast(deferred ? 'Snoozed' : 'Restored'); }
  catch (e) { toast(e.message); }
}

function setLane(name, html, count) {
  const lane = $(`#lane-${name}`);
  lane.querySelector('.lane-body').innerHTML = html;
  lane.classList.toggle('has-items', !!html);
  const c = lane.querySelector('.count');
  if (c) c.textContent = count ? `(${count})` : '';
}

// ---------------------------------------------------------------- inspector
async function openInspector(id) {
  inspectorTaskId = id;
  $('#inspector').style.display = '';
  $('#inspector-backdrop').style.display = '';
  renderInspector(id);
}
function closeInspector() {
  inspectorTaskId = null;
  $('#inspector').style.display = 'none';
  $('#inspector-backdrop').style.display = 'none';
}

function renderInspector(id, soft = false) {
  const t = taskById(id);
  const el = $('#inspector');
  if (!t) { if (!soft) closeInspector(); return; }
  if (soft && el.querySelector('textarea:focus, input:focus, select:focus')) return; // don't clobber edits
  const deps = t.dependsOn.map(d => taskById(d)?.title || d).map(esc).join(', ');
  el.innerHTML = `
    <button class="btn subtle insp-close">✕</button>
    <h2>${esc(t.title)}</h2>
    <div class="meta">
      <span class="badge ${t.author.kind === 'operator' ? 'operator' : 'claude'}">${t.author.kind === 'operator' ? 'Operator' : 'Claude'} · ${esc(t.author.detail)}</span>
      <span>${esc(t.status)}</span><span>r${t.revision}</span><span>p${t.priority}</span>
      <span>${esc(t.size)} / ${esc(t.risk)} risk</span><span>engine: ${esc(t.engine)}</span>
      <span title="${esc(t.id)}">${esc(t.id.slice(-6))}</span>
    </div>
    ${(['blocked', 'awaiting_operator'].includes(t.status) && t.blockedReason) ? `<div class="operator-callout">
      <h3>💬 Claude needs you</h3>
      <div class="op-msg">${esc(t.blockedReason)}</div>
      <div class="op-reply-row">
        <textarea id="op-reply" placeholder="Your answer — it goes straight into the task and unblocks it…" aria-label="Reply to Claude"></textarea>
        <button class="btn primary" id="op-reply-send">Reply &amp; unblock</button>
      </div>
    </div>` : (t.blockedReason ? `<div class="stale-reason">Earlier note (resolved): ${esc(t.blockedReason.split('\n')[0])}</div>` : '')}
    <section><h3>Instructions ${t.author.kind === 'operator' ? '(yours — AI never rewrites this)' : ''}</h3>
      <textarea id="i-instructions" rows="6">${esc(t.instructions)}</textarea>
      <div class="insp-actions"><button class="btn" id="i-save">Save changes</button></div>
    </section>
    <section><h3>Plan ${t.prep.state !== 'none' ? `· ${esc(t.prep.state)}` : ''}</h3>
      ${(t.prep.versions?.length || 0) > 1 ? `<select id="i-plan-version" aria-label="Plan version">${t.prep.versions.map((v, i) =>
        `<option value="${i}" ${i === t.prep.versions.length - 1 ? 'selected' : ''}>v${i + 1} · ${esc(v.model)} ${esc(v.mode)} · ${esc(v.ts.slice(0, 16).replace('T', ' '))}</option>`).join('')}</select>` : ''}
      <div class="prose" id="i-plan-text">${esc(t.prep.plan)}</div>
      ${t.prep.artifacts?.length ? `<div class="insp-actions">${t.prep.artifacts.map(a =>
        `<button class="btn subtle art-view" data-art="${esc(a)}">📄 ${esc(a.split('/').pop())}</button>`).join('')}</div>
      <div class="prose" id="art-content" style="display:none"></div>` : ''}
      <div class="insp-actions">
        <button class="btn" id="i-prep">${t.prep.state === 'none' ? 'Prepare with AI' : 'Re-prepare'}</button>
        <select id="i-prep-model">${['adaptive', 'opus', 'sonnet', 'haiku'].map(m => `<option ${t.prep.model === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
        <select id="i-prep-mode">${['full', 'quick'].map(m => `<option ${t.prep.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
      </div>
      <label class="field-label">Coordinator prompt</label>
      <textarea id="i-directive" rows="2" placeholder="Extra instructions for the planning coordinator…">${esc(t.prep.directive)}</textarea>
    </section>
    ${t.councils?.length ? `<section><h3>Council decisions</h3>${t.councils.map(c => `
      <div class="council-box">
        <div class="question">${esc(c.question)}</div>
        <div class="decision">${c.synthesis?.needsOperator ? '<span class="needs-operator">NEEDS OPERATOR · </span>' : ''}${esc(c.synthesis?.decision || '')} <span style="color:var(--faint)">(confidence ${esc(String(c.synthesis?.confidence ?? '?'))})</span></div>
        ${c.synthesis?.dissent ? `<div class="dissent">Dissent: ${esc(c.synthesis.dissent)}</div>` : ''}
        <details><summary>${c.votes.length} independent votes${c.missingVotes?.length ? ` (${c.missingVotes.length} failed)` : ''}</summary>
          ${c.votes.map(v => `<div class="vote"><span class="role">${esc(v.role)}</span> (${esc(String(v.confidence))}): ${esc(v.recommendation)}<br>+ ${esc(v.strongestFor)}<br>− ${esc(v.strongestAgainst)}</div>`).join('')}
        </details>
      </div>`).join('')}</section>` : ''}
    <section><h3>Subtasks (${t.subtasks.filter(s => s.status !== 'open').length}/${t.subtasks.length})</h3>
      ${t.subtasks.map(s => `<div class="subtask-row ${s.status !== 'open' ? 'done' : ''}">
        <input type="checkbox" data-sub="${esc(s.id)}" ${s.status !== 'open' ? 'checked' : ''}>
        <span class="st-title" title="${esc(s.instructions)}">${esc(s.title)}</span>
        <span class="who">${esc(s.author || '')}</span></div>`).join('') || '<div class="prose"></div>'}
    </section>
    <section><h3>Acceptance criteria (one per line)</h3>
      <textarea id="i-criteria" rows="${Math.min(6, t.acceptanceCriteria.length + 1)}" placeholder="What must be true for this task to count as done…">${esc(t.acceptanceCriteria.join('\n'))}</textarea>
    </section>
    ${deps ? `<section><h3>Depends on</h3><div class="prose">${deps}</div></section>` : ''}
    ${(t.verification.state !== 'none' || t.verification.evidence) ? `<section><h3>Verification</h3>
      <span class="chip verif-${esc(t.verification.state)}">${esc(t.verification.state)}</span>
      ${t.verification.findings?.length ? `<ul class="verif-findings">${t.verification.findings.map(f => `<li>${esc(typeof f === 'string' ? f : JSON.stringify(f))}</li>`).join('')}</ul>` : ''}
      ${t.verification.evidence ? `<div class="prose">${esc(t.verification.evidence)}</div>` : ''}
    </section>` : ''}
    ${t.source.context ? `<section><h3>Where this came from</h3><div class="prose">${esc(t.source.context)}</div></section>` : ''}
    <section><h3>Settings</h3>
      <label class="field-label">Title</label>
      <input id="i-title" type="text" maxlength="300" value="${esc(t.title)}">
      <div class="kv" style="margin-top:8px">
        <label>Priority <select id="i-priority">${[5, 4, 3, 2, 1].map(p => `<option ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        <label>Status <select id="i-status">${['inbox', 'preparing', 'ready', 'in_progress', 'blocked', 'awaiting_operator', 'review', 'done', 'archived'].map(s => `<option ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>Engine <select id="i-engine">${['auto', 'gsd-fast', 'gsd-quick', 'gsd-execute-phase', 'gsd-debug', 'rigorous', 'rigorous-lite', 'direct'].map(e => `<option ${t.engine === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
      </div>
    </section>
    <section><h3>Activity</h3>
      <div class="activity-list">${t.activity.slice(-12).reverse().map(a => `<div>${esc(a.ts.slice(0, 16).replace('T', ' '))} · ${esc(a.actor)} · ${esc(a.action)}${a.detail ? ' — ' + esc(String(a.detail).slice(0, 140)) : ''}</div>`).join('')}</div>
    </section>
    <div class="insp-actions">
      ${t.status !== 'done' ? `<button class="btn" id="i-done">Mark done (operator override)</button>` : ''}
      ${!['done', 'archived'].includes(t.status) ? (t.deferred
        ? `<button class="btn" id="i-reopen">Restore</button>`
        : `<button class="btn subtle" id="i-later">Snooze</button>`) : ''}
      ${t.status !== 'archived' ? `<button class="btn subtle" id="i-archive">Archive</button>` : ''}
    </div>`;

  el.querySelector('.insp-close').onclick = closeInspector;
  // patch REJECTS on failure — callers must not report success in .then-chains after a catch
  const patch = async (p, extra = {}) => {
    await api('PATCH', '/api/tasks', { expectedRevision: t.revision, patch: p, ...extra }, { id: t.id });
    await refresh();
  };
  const oops = e => { if (e?.message) toast(e.message); };
  $('#i-save').onclick = () => {
    const p = { instructions: $('#i-instructions').value };
    const ti = $('#i-title').value.trim(); if (ti && ti !== t.title) p.title = ti;
    const crit = $('#i-criteria').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (JSON.stringify(crit) !== JSON.stringify(t.acceptanceCriteria)) p.acceptanceCriteria = crit;
    const pr = Number($('#i-priority').value); if (pr !== t.priority) p.priority = pr;
    const stv = $('#i-status').value; if (stv !== t.status) p.status = stv;
    const en = $('#i-engine').value; if (en !== t.engine) p.engine = en;
    const dir = $('#i-directive').value; if (dir !== t.prep.directive) p.prep = { directive: dir };
    patch(p).then(() => toast('Saved')).catch(oops);
  };
  const replyBtn = $('#op-reply-send');
  if (replyBtn) replyBtn.onclick = () => {
    const answer = $('#op-reply').value.trim();
    if (!answer) return toast('Write an answer first');
    // one PATCH: append the reply to instructions, clear the block, make it pickable
    patch({
      instructions: `${t.instructions}\n\n---\n**Operator reply (${new Date().toISOString().slice(0, 16).replace('T', ' ')}):** ${answer}`,
      blockedReason: null,
      status: 'ready',
    }).then(() => toast('Reply delivered — task is back in the queue')).catch(oops);
  };
  $('#i-prep').onclick = async () => {
    try {
      await api('POST', '/api/tasks/prepare', { taskId: t.id, model: $('#i-prep-model').value, mode: $('#i-prep-mode').value, directive: $('#i-directive').value });
      toast('Planning session queued'); await refresh();
    } catch (e) { oops(e); }
  };
  const pvSel = $('#i-plan-version');
  if (pvSel) pvSel.onchange = () => { $('#i-plan-text').textContent = t.prep.versions[Number(pvSel.value)]?.plan || ''; };
  el.querySelectorAll('.art-view').forEach(b => b.onclick = async () => {
    try {
      const res = await fetch(`/api/artifact?project=${PROJECT}&path=${encodeURIComponent(b.dataset.art)}`, { credentials: 'same-origin' });
      const text = await res.text();
      const box = $('#art-content');
      box.style.display = ''; box.textContent = res.ok ? text : `could not load: ${text}`;
    } catch (e) { oops(e); }
  });
  el.querySelectorAll('[data-sub]').forEach(cb => cb.onchange = () => {
    const subtasks = t.subtasks.map(s => s.id === cb.dataset.sub ? { ...s, status: cb.checked ? 'done' : 'open' } : s);
    patch({ subtasks }).catch(oops);
  });
  const doneBtn = $('#i-done');
  if (doneBtn) doneBtn.onclick = () => {
    if (confirm('Mark this task done without Claude-verified evidence?')) {
      patch({ status: 'done', operatorOverride: true, verification: { state: 'passed', evidence: t.verification.evidence || 'Marked done by operator from the UI.' } })
        .then(() => toast('Marked done')).catch(oops);
    }
  };
  const archBtn = $('#i-archive');
  if (archBtn) archBtn.onclick = () => {
    const reason = prompt('Archive reason (kept in history):', 'no longer needed');
    if (reason !== null) patch({ status: 'archived', archivedReason: reason }).then(closeInspector).catch(oops);
  };
  const laterI = $('#i-later');
  if (laterI) laterI.onclick = () => patch({ deferred: true }).then(() => toast('Snoozed')).catch(oops);
  const reopenI = $('#i-reopen');
  if (reopenI) reopenI.onclick = () => patch({ deferred: false }).then(() => toast('Restored')).catch(oops);
}

// ---------------------------------------------------------------- activity tab
async function renderActivity() {
  const { events } = await api('GET', '/api/audit');
  $('#activity-view').innerHTML = events.map(e => `<div class="audit-row">
    <span class="ts">${esc(e.ts.slice(0, 19).replace('T', ' '))}</span>
    <span class="actor">${esc(e.actor)}</span>
    <span><strong>${esc(e.action)}</strong></span>
    <span class="detail">${esc(JSON.stringify(e.detail)).slice(0, 160)}</span>
  </div>`).join('') || '<div id="empty-state">No activity yet.</div>';
}

// ---------------------------------------------------------------- controls
function wireControls() {
  $('#parallel-toggle').checked = localStorage.getItem('ub-parallel') === '1';
  $('#parallel-toggle').onchange = e => localStorage.setItem('ub-parallel', e.target.checked ? '1' : '0');

  $('#preview-toggle').onchange = async e => {
    try { await api('POST', '/api/settings', { patch: { autoApplySchedule: !e.target.checked } }); toast(e.target.checked ? 'Order proposals will wait for your Apply' : 'Order proposals apply automatically (Undo available)'); }
    catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  };

  $('#order-btn').onclick = async () => {
    try {
      await api('POST', '/api/jobs/order', { parallel: $('#parallel-toggle').checked });
      toast('Ordering session started — it can only propose an order, never edit tasks');
    } catch (e) { toast(e.message); }
  };
  $('#undo-order-btn').onclick = async () => { try { await api('POST', '/api/schedule/undo'); toast('Previous order restored'); } catch (e) { toast(e.message); } };

  $('#pause-btn').onclick = async () => {
    try {
      if (STATE?.control.state === 'pause_requested') { await api('POST', '/api/control/cancel-pause'); toast('Pause cancelled'); }
      else { await api('POST', '/api/control/pause'); toast('Claude will pause at the next safe point'); }
    } catch (e) { toast(e.message); }
  };

  // Operator escape hatch: idle the loop even if the queue is not quiescent. First
  // ask the server WITHOUT force to collect the blockers, show them, then confirm.
  $('#force-idle-btn').onclick = async () => {
    let blockers = [];
    try {
      const res = await fetch(`/api/session/idle?project=${PROJECT}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'operator idle from UI' }) });
      if (res.ok) { toast('Loop idled'); await refresh(); return; }
      if (res.status === 409) blockers = (await res.json()).blockers || [];
      else { toast('Could not idle'); return; }
    } catch (e) { toast(e.message); return; }
    if (!confirm(`Force the work loop to idle?\n\nUnfinished work will be left in place:\n• ${blockers.join('\n• ')}\n\nThe queue is preserved; only the loop stops.`)) return;
    try { await api('POST', '/api/session/idle', { reason: 'operator force-idle from UI', force: true }); toast('Loop force-idled'); }
    catch (e) { toast(e.message); }
  };

  const overlay = $('#composer-overlay');
  const openComposer = () => { overlay.style.display = 'flex'; $('#c-title').focus(); };
  const closeComposer = () => { overlay.style.display = 'none'; };
  $('#new-task-btn').onclick = () => (overlay.style.display === 'none' ? openComposer() : closeComposer());
  overlay.onclick = e => { if (e.target === overlay) closeComposer(); };
  $('#composer').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#c-submit').click(); });
  $('#c-cancel').onclick = closeComposer;

  // side-question drawer (docked right)
  const drawer = $('#questions-drawer');
  const openDrawer = () => { drawer.classList.remove('closed'); $('#ask-q').focus(); };
  const closeDrawer = () => drawer.classList.add('closed');
  $('#ask-btn').onclick = () => (drawer.classList.contains('closed') ? openDrawer() : closeDrawer());
  $('#qd-close').onclick = closeDrawer;
  $('#ask-q').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#ask-submit').click(); });
  $('#ask-submit').onclick = async () => {
    const question = $('#ask-q').value.trim();
    if (!question) return toast('Type a question first');
    try {
      await api('POST', '/api/questions', { question, model: $('#ask-model').value });
      $('#ask-q').value = '';
      toast('Question dispatched — answering on the side');
    } catch (e) { toast(e.message); }
  };
  $('#c-prep').onchange = e => { $('#c-model-wrap').style.opacity = e.target.checked ? 1 : .4; };
  $('#c-submit').onclick = async () => {
    const title = $('#c-title').value.trim();
    if (!title) return toast('Give the task a name');
    try {
      await api('POST', '/api/tasks', {
        title,
        instructions: $('#c-instructions').value,
        priority: Number($('#c-priority').value),
        size: $('#c-size').value, risk: $('#c-risk').value,
        prep: {
          auto: $('#c-prep').checked,
          mode: $('#c-prep').checked ? $('#c-prep-mode').value : 'off',
          model: $('#c-model').value,
          directive: $('#c-directive').value,
        },
      });
      const willPrep = $('#c-prep').checked && $('#c-size').value !== 'trivial';
      ['#c-title', '#c-instructions', '#c-directive'].forEach(s => $(s).value = '');
      closeComposer();
      toast(willPrep ? 'Task added — a planning session will prepare it' : 'Task added');
    } catch (e) { toast(e.message); }
  };

  $('#note-send').onclick = sendNote;
  $('#note-input').onkeydown = e => { if (e.key === 'Enter') sendNote(); };
  async function sendNote() {
    const text = $('#note-input').value.trim();
    if (!text) return;
    try { await api('POST', '/api/notes', { text }); $('#note-input').value = ''; toast('Claude will see this at the next task boundary'); }
    catch (e) { toast(e.message); }
  }

  document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
    const isQueue = b.dataset.tab === 'queue';
    $('#queue-view').style.display = isQueue ? '' : 'none';
    $('#activity-view').style.display = isQueue ? 'none' : '';
    if (!isQueue) renderActivity().catch(e => toast(e.message));
  });

  document.querySelectorAll('#lane-done h2, #lane-archived h2, #lane-cold h2').forEach(h => h.onclick = () => h.parentElement.classList.toggle('collapsed'));
  $('#inspector-backdrop').onclick = closeInspector;

  const search = $('#search');
  if (search) search.oninput = applySearchFilter;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeInspector(); closeComposer(); $('#questions-drawer').classList.add('closed'); if (search && document.activeElement === search) { search.value = ''; applySearchFilter(); search.blur(); } return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/' && search) { e.preventDefault(); search.focus(); }
    else if (e.key === 'n') { e.preventDefault(); $('#new-task-btn').click(); }
  });
}

boot().catch(e => { document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">Unfinished Business server unreachable.<br><code>${esc(e.message)}</code></div>`; });
