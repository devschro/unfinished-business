#!/usr/bin/env node
// Unfinished Business installer — copies the app to ~/.claude/unfinished-business/
// and the skill to ~/.claude/skills/unfinished-business/. Idempotent; restarts a
// running server so it picks up the new code (queued jobs survive restarts).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coerceLoopbackPort, coerceServerPid } from './app/security.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const APP_DEST = path.join(os.homedir(), '.claude', 'unfinished-business');
const SKILL_DEST = path.join(os.homedir(), '.claude', 'skills', 'unfinished-business');
const DATA = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'UnfinishedBusiness');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const f = path.join(from, entry.name), t = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(f, t);
    else fs.copyFileSync(f, t);
  }
}

console.log('Unfinished Business — install');
copyDir(path.join(SRC, 'app'), APP_DEST);
console.log(`  app   → ${APP_DEST}`);
copyDir(path.join(SRC, 'skill'), SKILL_DEST);
console.log(`  skill → ${SKILL_DEST}  (/unfinished-business)`);

// restart a running server so it serves the new code
try {
  const info = JSON.parse(fs.readFileSync(path.join(DATA, 'server.json'), 'utf8'));
  const pid = coerceServerPid(info.pid);
  const port = coerceLoopbackPort(info.port);
  const alive = pid && port
    && await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    .then(r => r.json()).then(j => j.ok).catch(() => false);
  if (alive) {
    console.log(`  restarting server (pid ${pid}) to pick up new code…`);
    try {
      if (process.platform === 'win32') {
        // No shell: the validated numeric PID is passed as one argument.
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch {}
    await new Promise(r => setTimeout(r, 800));
    const child = spawn(process.execPath, [path.join(APP_DEST, 'ub-server.mjs')], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    console.log('  server restarted');
  }
} catch { /* no server running — it starts on first use */ }

console.log(`\nDone. In any project, run /unfinished-business in Claude Code.
Data lives in ${DATA} (outside OneDrive, survives /clear and reinstalls).
One-time (optional, enables separate-session planning): node "${path.join(APP_DEST, 'ub.mjs')}" login`);
