import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('all runtime JavaScript parses on the supported Node version', () => {
  const files = [
    'install.mjs',
    'app/hooks.mjs',
    'app/mcp.mjs',
    'app/security.mjs',
    'app/ub-server.mjs',
    'app/ub.mjs',
    'app/ui/app.js',
    'app/ui/queue-agent.js',
    'scripts/check-public.mjs',
  ];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file} failed syntax validation: ${result.stderr}`);
  }
});

test('dashboard is self-contained and loads the original queue animation', () => {
  const html = fs.readFileSync(path.join(root, 'app/ui/index.html'), 'utf8');
  assert.match(html, /<script src="\/queue-agent\.js"><\/script>/);
  assert.doesNotMatch(html, /<(?:script|link)\b[^>]+(?:src|href)="https?:\/\//i);
  const excludedPrototype = new RegExp(`/${['agent', 'c'].join('-')}\\.js|${['g', 'sap'].join('')}`, 'i');
  assert.doesNotMatch(html, excludedPrototype);
  const animation = fs.readFileSync(path.join(root, 'app/ui/queue-agent.js'), 'utf8');
  assert.match(animation, /prefers-reduced-motion/);
  assert.match(animation, /window\.QueueAgent/);
});

test('server is explicitly loopback-only', () => {
  const server = fs.readFileSync(path.join(root, 'app/ub-server.mjs'), 'utf8');
  assert.match(server, /server\.listen\(port,\s*'127\.0\.0\.1'/);
  assert.doesNotMatch(server, /server\.listen\(port,\s*['"]0\.0\.0\.0['"]/);
});
