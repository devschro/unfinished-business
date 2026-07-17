import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'app', 'ub-server.mjs');

async function waitForServer(file, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      const response = await fetch(`http://127.0.0.1:${info.port}/api/health`);
      if (response.ok) return info;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test server did not start');
}

async function json(response) {
  return { response, body: await response.json().catch(() => ({})) };
}

test('bootstrap requires a one-use launch and exposes neither token nor registry path', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ub-public-bootstrap-'));
  const localAppData = path.join(tmp, 'local-app-data');
  const home = path.join(tmp, 'home');
  const projectPath = path.join(tmp, 'sensitive-project-location');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      APPDATA: path.join(tmp, 'app-data'),
      HOME: home,
      USERPROFILE: home,
      UB_PORT: '0',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const serverFile = path.join(localAppData, 'UnfinishedBusiness', 'server.json');
  const info = await waitForServer(serverFile, child);
  const base = `http://127.0.0.1:${info.port}`;

  const unauth = await json(await fetch(`${base}/api/bootstrap`));
  assert.equal(unauth.response.status, 401);
  assert.equal(JSON.stringify(unauth.body).includes(info.uiToken), false);
  assert.equal(JSON.stringify(unauth.body).includes(projectPath), false);

  const cliHeaders = { 'X-UB-Token': info.cliToken, 'Content-Type': 'application/json' };
  const registered = await json(await fetch(`${base}/api/projects`, {
    method: 'POST', headers: cliHeaders, body: JSON.stringify({ path: projectPath, name: 'Fixture Project' }),
  }));
  assert.equal(registered.response.status, 200);
  const projectId = registered.body.project.id;

  const unauthAfterRegistration = await json(await fetch(`${base}/api/bootstrap`));
  assert.equal(unauthAfterRegistration.response.status, 401);
  assert.equal(JSON.stringify(unauthAfterRegistration.body).includes(info.uiToken), false);
  assert.equal(JSON.stringify(unauthAfterRegistration.body).includes(projectPath), false);

  const launch = await json(await fetch(`${base}/api/ui-launch?project=${encodeURIComponent(projectId)}`, {
    method: 'POST', headers: cliHeaders, body: '{}',
  }));
  assert.equal(launch.response.status, 200);
  assert.match(launch.body.nonce, /^[a-f0-9]{48}$/);

  const exchange = await json(await fetch(`${base}/api/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: launch.body.nonce }),
  }));
  assert.equal(exchange.response.status, 200);
  assert.deepEqual(exchange.body.projects, [{ id: projectId, name: 'Fixture Project' }]);
  assert.equal('token' in exchange.body, false);
  assert.equal(JSON.stringify(exchange.body).includes(projectPath), false);

  const cookie = exchange.response.headers.get('set-cookie');
  assert.match(cookie, /^ub_ui=[a-f0-9]{48};/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.equal(cookie.includes(info.uiToken), false, 'browser credential must not be the operator token');

  const replay = await json(await fetch(`${base}/api/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: launch.body.nonce }),
  }));
  assert.equal(replay.response.status, 401);

  const authenticated = await json(await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie.split(';', 1)[0] } }));
  assert.equal(authenticated.response.status, 200);
  assert.deepEqual(authenticated.body.projects, [{ id: projectId, name: 'Fixture Project' }]);
  assert.equal('token' in authenticated.body, false);
  assert.equal(JSON.stringify(authenticated.body).includes(projectPath), false);
});
