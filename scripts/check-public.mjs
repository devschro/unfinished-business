#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const findings = [];
const binaryExtensions = new Set(['.gif', '.png', '.jpg', '.jpeg', '.ico', '.webp']);
const skippedDirectories = new Set(['.git', 'node_modules', 'coverage']);

function report(file, rule, line = null) {
  findings.push({ file: file.replaceAll('\\', '/'), rule, line });
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      report(path.relative(root, absolute), 'symbolic links are not allowed in the public release');
    } else if (entry.isDirectory()) {
      walk(absolute, files);
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute));
    }
  }
  return files;
}

function releaseFiles() {
  const localGit = fs.existsSync(path.join(root, '.git'));
  const git = localGit ? spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }) : null;
  if (git?.status === 0 && git.stdout) return git.stdout.split('\0').filter(Boolean);
  return walk(root);
}

const files = releaseFiles();
const normalized = files.map(file => file.replaceAll('\\', '/'));

const required = [
  'README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'NOTICE',
  'install.mjs', 'app/ub-server.mjs', 'app/ub.mjs', 'app/ui/queue-agent.js',
  'skill/SKILL.md', '.github/assets/agent-orchestration.gif',
  '.github/assets/agent-orchestration-poster.png', '.github/assets/social-preview.png',
];
for (const file of required) {
  if (!normalized.includes(file)) report(file, 'required public-release file is missing');
}

const forbiddenPathRules = [
  { re: /(^|\/)\.planning(\/|$)/i, name: 'private planning directory' },
  { re: /(^|\/)\.claude(\/|$)/i, name: 'local Claude configuration directory' },
  { re: /(^|\/)\.codex(\/|$)/i, name: 'local Codex configuration directory' },
  { re: /(^|\/)(?:handoff|\.continue-here)(?:\.|$)/i, name: 'private handoff artifact' },
  { re: /(^|\/)(?:auth|server|registry)\.json$/i, name: 'runtime token or registry file' },
  { re: /(^|\/)audit\.jsonl$/i, name: 'runtime audit log' },
  { re: /\.(?:db|sqlite|sqlite3|wal|shm)$/i, name: 'runtime database file' },
  { re: /(^|\/)(?:backups|spool|claude-config)(\/|$)/i, name: 'runtime state directory' },
  { re: /(^|\/)agent-c(?:-animations)?\.(?:js|html)$/i, name: 'excluded prototype animation' },
];

for (const file of normalized) {
  for (const rule of forbiddenPathRules) {
    if (rule.re.test(file)) report(file, rule.name);
  }
  const size = fs.statSync(path.join(root, file)).size;
  if (size > 1_000_000) report(file, `file exceeds the 1 MB repository-health budget (${size} bytes)`);
}

const privacyRules = [
  { name: 'Windows user-profile path', re: /\b[A-Z]:\\Users\\[^\\\s"'`]+/gi },
  { name: 'macOS or Linux home path', re: /\/(?:Users|home)\/[^/\s"'`]+/g },
  { name: 'email address', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { name: 'phone-number-shaped value', re: /(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g },
  { name: 'street-address-shaped value', re: /\b\d{1,6}\s+[A-Za-z][A-Za-z0-9.' -]{2,45}\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct)\b/gi },
  { name: 'GitHub access token', re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: 'OpenAI-style secret key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'AWS access-key identifier', re: /\bAKIA[A-Z0-9]{16}\b/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'authorization bearer value', re: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi },
  { name: 'excluded prototype reference', re: /\b(?:Agent C|canonical clawd|agent-c-animations|gsap)\b/gi },
];

for (const file of normalized) {
  if (file === 'scripts/check-public.mjs' || binaryExtensions.has(path.extname(file).toLowerCase())) continue;
  const absolute = path.join(root, file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(absolute));
  } catch {
    report(file, 'text file is not valid UTF-8');
    continue;
  }
  for (const rule of privacyRules) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(text)) !== null) {
      const line = text.slice(0, match.index).split('\n').length;
      report(file, rule.name, line);
      if (match[0].length === 0) rule.re.lastIndex += 1;
    }
  }
  if (/\b(?:cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\b/i.test(text)) {
    report(file, 'remote UI dependency');
  }
}

const readme = path.join(root, 'README.md');
if (fs.existsSync(readme) && fs.statSync(readme).size > 500 * 1024) {
  report('README.md', 'README exceeds GitHub rendering limit');
}

const assetBudgets = [
  ['.github/assets/agent-orchestration.gif', 1_000_000],
  ['.github/assets/agent-orchestration-poster.png', 500_000],
  ['.github/assets/social-preview.png', 1_000_000],
];
for (const [file, limit] of assetBudgets) {
  const absolute = path.join(root, file);
  if (fs.existsSync(absolute) && fs.statSync(absolute).size > limit) {
    report(file, `asset exceeds ${limit}-byte budget`);
  }
}

const enforceReleaseHistory = process.argv.includes('--release-history');
const history = enforceReleaseHistory && fs.existsSync(path.join(root, '.git'))
  ? spawnSync('git', ['-C', root, 'rev-list', '--max-parents=0', '--all'], { encoding: 'utf8' })
  : null;
if (history?.status === 0 && history.stdout.trim()) {
  const roots = history.stdout.trim().split(/\s+/);
  if (roots.length !== 1) report('.git', 'public history must have exactly one root commit');
  const identities = spawnSync('git', ['-C', root, 'log', '--format=%an%x00%ae'], { encoding: 'utf8' });
  for (const record of identities.stdout.split('\n').filter(Boolean)) {
    const [name, email] = record.split('\0');
    if (name !== 'Unfinished Business contributors') report('.git', 'commit author name is not the privacy-safe project identity');
    if (!/^\d+\+[a-z0-9-]+@users\.noreply\.github\.com$/i.test(email || '')) {
      report('.git', 'commit author email is not a GitHub noreply address');
    }
  }
}

if (findings.length) {
  console.error(`Public-release check failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(`- ${finding.file}${finding.line ? `:${finding.line}` : ''} — ${finding.rule}`);
  }
  process.exit(1);
}

console.log(`Public-release check passed (${files.length} files; privacy, secrets, paths, history, and asset budgets checked).`);
