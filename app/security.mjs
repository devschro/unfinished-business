import crypto from 'node:crypto';

export const UI_COOKIE_NAME = 'ub_ui';

export function coerceLoopbackPort(value) {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const port = Number(value);
  return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function coerceServerPid(value) {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff ? pid : null;
}

export function readCookie(header, name) {
  if (!header || !name) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 1 || part.slice(0, i).trim() !== name) continue;
    return part.slice(i + 1).trim() || null;
  }
  return null;
}

export function publicProjects(projects, onlyId = null) {
  if (!Array.isArray(projects)) return [];
  return projects
    .filter(p => p && (!onlyId || p.id === onlyId))
    .map(p => ({ id: String(p.id || ''), name: String(p.name || '') }));
}

export function createLaunchTickets({ ttlMs = 120_000, now = () => Date.now(), randomToken } = {}) {
  const tickets = new Map();
  const token = randomToken || (() => crypto.randomBytes(24).toString('hex'));

  function prune() {
    const at = now();
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= at) tickets.delete(key);
  }

  return {
    mint(projectId) {
      prune();
      const nonce = token();
      const expiresAt = now() + ttlMs;
      tickets.set(nonce, { projectId, expiresAt });
      return { nonce, expiresAt };
    },
    consume(nonce) {
      if (typeof nonce !== 'string' || !nonce) return null;
      const ticket = tickets.get(nonce);
      tickets.delete(nonce); // every presented ticket is one-shot, valid or expired
      if (!ticket || ticket.expiresAt <= now()) return null;
      return ticket;
    },
    size() { prune(); return tickets.size; },
  };
}
