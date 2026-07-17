import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  coerceLoopbackPort,
  coerceServerPid,
  createLaunchTickets,
  publicHttpFailure,
  publicProjects,
  readCookie,
} from '../app/security.mjs';

test('coerceLoopbackPort accepts only a numeric TCP port', () => {
  assert.equal(coerceLoopbackPort(47821), 47821);
  assert.equal(coerceLoopbackPort('47821'), 47821);
  for (const value of [0, -1, 1.5, 65536, '', '0', '1.5', '47821:80', '80/path', {}, null]) {
    assert.equal(coerceLoopbackPort(value), null, `expected rejection for ${String(value)}`);
  }
});

test('coerceServerPid accepts only positive 32-bit integer PIDs', () => {
  assert.equal(coerceServerPid(42), 42);
  assert.equal(coerceServerPid('42'), 42);
  for (const value of [0, -1, 1.5, NaN, '', '0', '-1', '1.5', '42 & whoami', '42 /t', {}, null, 0x80000000]) {
    assert.equal(coerceServerPid(value), null, `expected rejection for ${String(value)}`);
  }
});

test('installer invokes taskkill without a command shell', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '..', 'install.mjs'), 'utf8');
  assert.doesNotMatch(source, /\bexecSync\b/);
  assert.match(source, /spawnSync\('taskkill', \['\/pid', String\(pid\), '\/t', '\/f'\]/);
});

test('fallback authentication tokens are never accepted as command arguments', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '..', 'app', 'ub.mjs'), 'utf8');
  assert.match(source, /flags\.token !== '-'/);
  assert.match(source, /await readStdin\(\)/);
  assert.doesNotMatch(source, /login --token <token>/);
});

test('publicProjects strips paths and all non-display registry fields', () => {
  const projects = publicProjects([
    { id: 'one', name: 'One', path: 'private-path', createdAt: 'private-time', secret: 'private' },
    { id: 'two', name: 'Two', path: 'another-private-path' },
  ], 'one');
  assert.deepEqual(projects, [{ id: 'one', name: 'One' }]);
  assert.equal(JSON.stringify(projects).includes('private'), false);
});

test('unexpected server errors never expose messages or stack-derived paths', () => {
  const unexpected = new Error('sensitive internal path');
  unexpected.stack = 'stack with sensitive internal path';
  assert.deepEqual(publicHttpFailure(unexpected), {
    code: 500,
    payload: { error: 'internal server error' },
  });

  const expected = new Error('internal diagnostic');
  expected.statusCode = 409;
  expected.publicMessage = 'revision conflict';
  expected.publicBody = { expectedRev: 4 };
  assert.deepEqual(publicHttpFailure(expected), {
    code: 409,
    payload: { expectedRev: 4, error: 'revision conflict' },
  });
});

test('launch tickets are short-lived and one-use', () => {
  let now = 1_000;
  let n = 0;
  const tickets = createLaunchTickets({ ttlMs: 50, now: () => now, randomToken: () => `ticket-${++n}` });
  const first = tickets.mint('project-one');
  assert.deepEqual(tickets.consume(first.nonce), { projectId: 'project-one', expiresAt: 1_050 });
  assert.equal(tickets.consume(first.nonce), null);

  const second = tickets.mint('project-two');
  now = 1_050;
  assert.equal(tickets.consume(second.nonce), null);
  assert.equal(tickets.size(), 0);
});

test('readCookie selects an exact cookie name', () => {
  assert.equal(readCookie('other=x; ub_ui=session-value; suffix=y', 'ub_ui'), 'session-value');
  assert.equal(readCookie('not_ub_ui=x', 'ub_ui'), null);
  assert.equal(readCookie('', 'ub_ui'), null);
});
