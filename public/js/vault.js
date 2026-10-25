// Encrypted storage for the hosted (GitHub Pages) version.
//
// The whole logbook is encrypted in the browser with AES-256-GCM, using a key derived from
// your password with PBKDF2-SHA256 (600k iterations). Only the ciphertext is ever stored in
// the repository, so visitors to the site, or anyone browsing the repo, see nothing readable.
// Every save is a commit, so git history doubles as a full version history.

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const ITERATIONS = 600000;

export const VAULT_FILE = 'vault.json';

// ---------- crypto
export async function deriveKey(password, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

// A session: the derived key plus the salt it belongs to (needed to write the file back).
export async function newSession(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveKey(password, salt), salt, iterations: ITERATIONS };
}

export async function seal(session, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.key, enc.encode(JSON.stringify(payload)));
  return {
    format: 'skylog-vault', v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: session.iterations, salt: b64(session.salt) },
    iv: b64(iv), data: b64(data),
  };
}

// Throws 'bad-password' if the password (or key) doesn't open this vault.
export async function openVault(vault, passwordOrSession) {
  if (vault?.format !== 'skylog-vault') throw new Error('not-a-vault');
  const salt = unb64(vault.kdf.salt);
  const session = typeof passwordOrSession === 'string'
    ? { key: await deriveKey(passwordOrSession, salt, vault.kdf.iterations), salt, iterations: vault.kdf.iterations }
    : passwordOrSession;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, session.key, unb64(vault.data));
    return { session, payload: JSON.parse(dec.decode(plain)) };
  } catch { throw new Error('bad-password'); }
}

// Sessions can be kept for the tab (sessionStorage) or, if asked, on this device (localStorage).
export async function exportSession(s) {
  return JSON.stringify({ key: b64(await crypto.subtle.exportKey('raw', s.key)), salt: b64(s.salt), iterations: s.iterations });
}
export async function importSession(json) {
  const o = JSON.parse(json);
  const key = await crypto.subtle.importKey('raw', unb64(o.key), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  return { key, salt: unb64(o.salt), iterations: o.iterations };
}

// ---------- GitHub repository as the store
// Where this copy of the site lives: <owner>.github.io/<repo>/  (or a build-time override for testing).
export function detectRepo() {
  const cfg = globalThis.SKYLOG_CONFIG;
  if (cfg?.repo) return { owner: cfg.repo.split('/')[0], repo: cfg.repo.split('/')[1], api: cfg.api || 'https://api.github.com' };
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (!m) return null;
  const first = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m[1], repo: first && !first.includes('.') ? first : `${m[1]}.github.io`, api: 'https://api.github.com' };
}

const utf8b64 = s => { const bytes = enc.encode(s); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };

export function githubStore(where) {
  const url = `${where.api}/repos/${where.owner}/${where.repo}/contents/${VAULT_FILE}`;
  const headers = token => ({ Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  return {
    where,
    // -> { vault, sha } or null when the repo has no vault yet
    async read(token) {
      const r = await fetch(url, { headers: headers(token), cache: 'no-store' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`GitHub read failed (${r.status})`);
      const j = await r.json();
      const text = j.content ? dec.decode(unb64(j.content.replace(/\s/g, ''))) : await (await fetch(j.download_url, { cache: 'no-store' })).text();
      return { vault: JSON.parse(text), sha: j.sha };
    },
    // -> new sha. Throws { conflict: true } if someone else saved first.
    async write(token, vault, sha, message = 'Update flight log') {
      const r = await fetch(url, {
        method: 'PUT', headers: { ...headers(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content: utf8b64(JSON.stringify(vault)), ...(sha ? { sha } : {}) }),
      });
      if (r.status === 409 || r.status === 422) throw Object.assign(new Error('conflict'), { conflict: true });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('GitHub refused the token'), { auth: true });
      if (!r.ok) throw new Error(`GitHub save failed (${r.status})`);
      return (await r.json()).content.sha;
    },
    // Checks the token can write to this repository.
    async checkToken(token) {
      const r = await fetch(`${where.api}/repos/${where.owner}/${where.repo}`, { headers: headers(token), cache: 'no-store' });
      if (!r.ok) return { ok: false, reason: r.status === 401 ? 'The token was rejected.' : `GitHub said ${r.status}.` };
      const j = await r.json();
      return j.permissions?.push ? { ok: true } : { ok: false, reason: `The token can't write to ${where.owner}/${where.repo}. Give it Contents: Read and write.` };
    },
  };
}
