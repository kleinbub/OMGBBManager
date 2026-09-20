/**
 * OMGBBManager - tiny zero-dependency server for the Beyblade X collection manager.
 *
 * Responsibilities:
 *   - serve the static app from ./public
 *   - persist the collection as plain JSON in ./data
 *   - proxy (and aggressively cache + rate limit) requests to the Beyblade Wiki API,
 *     so the app never hammers fandom.com and never trips CORS.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'wiki-cache');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const PORT = Number(process.env.PORT) || 4173;
const WIKI_API = 'https://beyblade.fandom.com/api.php';
const USER_AGENT =
  'OMGBBManager/1.0 (personal Beyblade X collection manager; single-user, manual fetch only)';

// Politeness controls. Every upstream call is manual (button driven), but these
// guarantee we stay well under anything that could look like scraping.
const MIN_GAP_MS = 1100; // minimum spacing between two upstream requests
const HOURLY_BUDGET = 300; // hard ceiling of upstream requests per rolling hour

const FILES = {
  collection: path.join(DATA_DIR, 'collection.json'),
  index: path.join(DATA_DIR, 'part-index.json'),
};

const DEFAULTS = {
  collection: { schema: 1, updatedAt: null, beyblades: [], parts: {}, combos: [] },
  index: { schema: 1, updatedAt: null, categories: {} },
};

/* ------------------------------------------------------------------ helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback);
    throw err;
  }
}

/** Atomic write: temp file + rename, so a crash mid-save cannot shred the collection. */
async function writeJsonFile(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** Keep a rolling set of backups so a bad import is always recoverable. */
async function backup(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.basename(file, '.json');
    await fsp.writeFile(path.join(BACKUP_DIR, base + '-' + stamp + '.json'), raw, 'utf8');

    const kept = (await fsp.readdir(BACKUP_DIR))
      .filter((f) => f.startsWith(base))
      .sort()
      .reverse();
    for (const stale of kept.slice(40)) {
      await fsp.rm(path.join(BACKUP_DIR, stale), { force: true });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('backup failed:', err.message);
  }
}

/* -------------------------------------------------------------- wiki proxy */

// Only these MediaWiki parameters are forwarded upstream.
const ALLOWED_PARAMS = new Set([
  'action', 'format', 'formatversion', 'page', 'prop', 'titles', 'redirects',
  'list', 'srsearch', 'srlimit', 'srnamespace', 'cmtitle', 'cmlimit',
  'cmcontinue', 'search', 'limit', 'namespace', 'rvprop', 'rvslots', 'section', 'cllimit', 'acprefix', 'aclimit', 'cmnamespace', 'rvsection', 'rvcontinue', 'continue',
]);
const ALLOWED_ACTIONS = new Set(['parse', 'query', 'opensearch']);

const upstream = {
  lastAt: 0,
  chain: Promise.resolve(),
  recent: [], // timestamps of calls within the last hour
  total: 0,
  cacheHits: 0,
};

function budgetLeft() {
  const cutoff = Date.now() - 3600000;
  upstream.recent = upstream.recent.filter((t) => t > cutoff);
  return HOURLY_BUDGET - upstream.recent.length;
}

/** Serialise upstream calls and space them out by at least MIN_GAP_MS. */
function queueUpstream(task) {
  const run = upstream.chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - upstream.lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    upstream.lastAt = Date.now();
    upstream.recent.push(Date.now());
    upstream.total += 1;
    return task();
  });
  // Keep the chain alive even if one call rejects.
  upstream.chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function cacheKey(params) {
  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex');
}

async function handleWiki(req, res, url) {
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (ALLOWED_PARAMS.has(key)) params.set(key, value);
  }
  const action = params.get('action');
  if (!ALLOWED_ACTIONS.has(action)) {
    return sendJson(res, 400, { error: 'action "' + action + '" is not allowed' });
  }
  params.set('format', 'json');
  if (action !== 'opensearch') params.set('formatversion', '2');

  const key = cacheKey(params);
  const cacheFile = path.join(CACHE_DIR, key + '.json');
  const fresh = url.searchParams.get('fresh') === '1';

  if (!fresh) {
    try {
      const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      upstream.cacheHits += 1;
      return sendJson(res, 200, {
        cached: true,
        fetchedAt: cached.fetchedAt,
        data: cached.data,
      });
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('cache read failed:', err.message);
    }
  }

  if (budgetLeft() <= 0) {
    return sendJson(res, 429, {
      error:
        'Hourly wiki budget of ' + HOURLY_BUDGET + ' requests is used up. ' +
        'Cached pages still work; try again later.',
    });
  }

  const target = WIKI_API + '?' + params.toString();
  try {
    const payload = await queueUpstream(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
        const upstreamRes = await fetch(target, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!upstreamRes.ok) {
          throw new Error('wiki responded ' + upstreamRes.status + ' ' + upstreamRes.statusText);
        }
        return await upstreamRes.json();
      } finally {
        clearTimeout(timer);
      }
    });

    const record = { url: target, fetchedAt: new Date().toISOString(), data: payload };
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(record), 'utf8');
    sendJson(res, 200, { cached: false, fetchedAt: record.fetchedAt, data: payload });
  } catch (err) {
    sendJson(res, 502, { error: 'Wiki request failed: ' + err.message });
  }
}

/* ------------------------------------------------------- document operations */

/*
 * Shelves and the catalogue are never uploaded whole. The browser sends small
 * operations and the server applies them to the current file under a lock:
 * requests stay a few kilobytes, and two tabs (or a tab running an older
 * version of the app) cannot overwrite each other. public/api.php implements
 * the identical protocol.
 */

const API_VERSION = 3;
const MAX_OPS = 200;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PART_KEY = /^[A-Za-z]{1,20}:[a-z0-9]{0,80}$/;
const PART_KIND = /^[A-Za-z]{1,20}$/;

class OpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fileLocks = new Map();

/** Run task alone for this file; later callers queue behind it. */
function withFileLock(file, task) {
  const previous = fileLocks.get(file) || Promise.resolve();
  const run = previous.then(task, task);
  fileLocks.set(
    file,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseOps(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new OpError(400, 'body is not valid JSON');
  }
  if (!isPlainObject(body)) throw new OpError(400, 'expected a JSON object');
  if (!Array.isArray(body.ops)) {
    // A whole document: an open tab still running an older version of the app.
    throw new OpError(
      409,
      'This page is running an older version of the app. Reload it to keep saving.',
      'stale-client'
    );
  }
  if (!body.ops.length || body.ops.length > MAX_OPS) {
    throw new OpError(400, 'expected 1 to ' + MAX_OPS + ' operations');
  }
  return body.ops;
}

function applyShelfOps(current, ops) {
  let doc = isPlainObject(current) ? current : { schema: 1 };
  if (!Array.isArray(doc.beyblades)) doc.beyblades = [];
  if (!Array.isArray(doc.combos)) doc.combos = [];
  if (!isPlainObject(doc.parts)) doc.parts = {};

  for (const op of ops) {
    if (!isPlainObject(op)) throw new OpError(400, 'Each operation must be an object.');
    if (op.op === 'putEntry') {
      if (!isPlainObject(op.entry) || !ENTRY_ID.test(String(op.entry.id || ''))) {
        throw new OpError(400, 'putEntry needs an entry with an id.');
      }
      const at = doc.beyblades.findIndex((b) => b && b.id === op.entry.id);
      if (at >= 0) doc.beyblades[at] = op.entry;
      else doc.beyblades.push(op.entry);
    } else if (op.op === 'removeEntry') {
      if (!ENTRY_ID.test(String(op.id || ''))) throw new OpError(400, 'removeEntry needs an id.');
      doc.beyblades = doc.beyblades.filter((b) => !b || b.id !== op.id);
    } else if (op.op === 'putPart') {
      if (!PART_KEY.test(String(op.key || '')) || !isPlainObject(op.part)) {
        throw new OpError(400, 'putPart needs a part key and a part.');
      }
      doc.parts[op.key] = op.part;
    } else if (op.op === 'putCombo') {
      if (!isPlainObject(op.combo) || !ENTRY_ID.test(String(op.combo.id || ''))) {
        throw new OpError(400, 'putCombo needs a combo with an id.');
      }
      const at = doc.combos.findIndex((c) => c && c.id === op.combo.id);
      if (at >= 0) doc.combos[at] = op.combo;
      else doc.combos.push(op.combo);
    } else if (op.op === 'removeCombo') {
      if (!ENTRY_ID.test(String(op.id || ''))) throw new OpError(400, 'removeCombo needs an id.');
      doc.combos = doc.combos.filter((c) => !c || c.id !== op.id);
    } else if (op.op === 'replace') {
      if (!isPlainObject(op.doc) || !Array.isArray(op.doc.beyblades)) {
        throw new OpError(400, 'replace needs a shelf document.');
      }
      if (Number(op.baseRevision) !== (Number(doc.revision) || 0)) {
        throw new OpError(409, 'The shelf changed since this page loaded it. Reload, then import again.', 'conflict');
      }
      const revision = doc.revision;
      doc = op.doc;
      doc.revision = revision;
      if (!isPlainObject(doc.parts)) doc.parts = {};
      if (!Array.isArray(doc.combos)) doc.combos = [];
    } else {
      throw new OpError(400, 'Unknown operation "' + op.op + '".');
    }
  }
  return doc;
}

function applyIndexOps(current, ops) {
  const doc = isPlainObject(current) ? current : {};
  if (!isPlainObject(doc.categories)) doc.categories = {};

  for (const op of ops) {
    if (!isPlainObject(op)) throw new OpError(400, 'Each operation must be an object.');
    if (op.op === 'setCategory') {
      if (!PART_KIND.test(String(op.kind || '')) || !Array.isArray(op.items)) {
        throw new OpError(400, 'setCategory needs a kind and a list of items.');
      }
      doc.categories[op.kind] = op.items;
    } else if (op.op === 'setProducts') {
      const { start, total, items } = op;
      if (!Number.isInteger(start) || start < 0 || !Number.isInteger(total) || total < 0 || !Array.isArray(items)) {
        throw new OpError(400, 'setProducts needs start, total and items.');
      }
      const existing = Array.isArray(doc.products) ? doc.products : [];
      if (start > existing.length) {
        throw new OpError(409, 'Catalogue pieces arrived out of order. Sync again.', 'conflict');
      }
      doc.products = existing.slice(0, start).concat(items).slice(0, total);
    } else if (op.op === 'finish') {
      if (!Number.isInteger(op.productsTotal)) throw new OpError(400, 'finish needs productsTotal.');
      doc.schema = Number.isInteger(op.schema) ? op.schema : 2;
      doc.productsTotal = op.productsTotal;
      doc.catalogueUpdatedAt =
        typeof op.catalogueUpdatedAt === 'string' ? op.catalogueUpdatedAt : new Date().toISOString();
    } else {
      throw new OpError(400, 'Unknown operation "' + op.op + '".');
    }
  }
  return doc;
}

/* -------------------------------------------------------------------- shelves */

/*
 * Each account owns a shelf: data/collections/<userId>.json. Any signed-in
 * blader may read another shelf; writes always land on the session user's own,
 * whatever the request asks for.
 */

const COLLECTIONS_DIR = path.join(DATA_DIR, 'collections');
const LEGACY_COLLECTION = path.join(DATA_DIR, 'collection.json');

function collectionFile(userId) {
  return path.join(COLLECTIONS_DIR, userId + '.json');
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/** The single pre-accounts collection becomes the owner's shelf, once. */
async function adoptLegacyCollection(user) {
  if (!user || !user.owner) return;
  const target = collectionFile(user.id);
  if (await exists(target)) return;
  if (!(await exists(LEGACY_COLLECTION))) return;
  await fsp.mkdir(COLLECTIONS_DIR, { recursive: true });
  await fsp.rename(LEGACY_COLLECTION, target);
  console.log('  Adopted the pre-accounts collection as ' + user.username + "'s shelf");
}

async function findUser(userId) {
  const doc = await readJsonFile(AUTH_FILES.users, AUTH_DEFAULTS.users);
  return (doc.users || []).find((u) => u.id === userId) || null;
}

/** Headline numbers for the blader list, cheap enough to compute on the fly. */
function summariseCollection(doc) {
  const beys = Array.isArray(doc.beyblades) ? doc.beyblades : [];
  const partKeys = new Set();
  const types = new Map();
  let units = 0;
  let wishlist = 0;

  for (const bey of beys) {
    // Wishlist entries are wants, not holdings: count them apart.
    if (bey.status === 'wish') {
      wishlist += 1;
      continue;
    }
    const qty = Math.max(1, Number(bey.qty) || 1);
    units += qty;
    for (const key of Object.values(bey.partKeys || {})) partKeys.add(key);
    const type = bey.bey && bey.bey.type;
    if (type) types.set(type, (types.get(type) || 0) + qty);
  }

  let topType = null;
  let best = 0;
  for (const [type, count] of types) {
    if (count > best) {
      best = count;
      topType = type;
    }
  }
  return {
    products: beys.length - wishlist,
    wishlist,
    units,
    uniqueParts: partKeys.size,
    combos: Array.isArray(doc.combos) ? doc.combos.length : 0,
    topType,
    updatedAt: doc.updatedAt || null,
  };
}

async function handleUsers(req, res) {
  const doc = await readJsonFile(AUTH_FILES.users, AUTH_DEFAULTS.users);
  const list = [];
  for (const account of doc.users || []) {
    await adoptLegacyCollection(account);
    const shelf = await readJsonFile(collectionFile(account.id), {});
    list.push({
      id: account.id,
      username: account.username,
      owner: Boolean(account.owner),
      createdAt: account.createdAt || null,
      stats: summariseCollection(shelf),
    });
  }
  sendJson(res, 200, { users: list });
}

async function handleCollection(req, res, url) {
  const me = await currentUser(req);

  if (req.method === 'GET') {
    const wanted = url.searchParams.get('user');
    const target = !wanted || wanted === me.id ? me : await findUser(wanted);
    if (!target) return sendJson(res, 404, { error: 'No blader by that id.' });
    await adoptLegacyCollection(target);
    return sendJson(res, 200, await readJsonFile(collectionFile(target.id), DEFAULTS.collection));
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    // Deliberately ignores any ?user= - you can only write your own shelf.
    await adoptLegacyCollection(me);
    const file = collectionFile(me.id);
    try {
      const ops = parseOps(await readBody(req));
      const result = await withFileLock(file, async () => {
        const current = await readJsonFile(file, DEFAULTS.collection);
        const doc = applyShelfOps(structuredClone(current), ops);
        doc.revision = (Number(current.revision) || 0) + 1;
        doc.updatedAt = new Date().toISOString();
        await fsp.mkdir(COLLECTIONS_DIR, { recursive: true });
        await backup(file);
        await writeJsonFile(file, doc);
        return { ok: true, revision: doc.revision, updatedAt: doc.updatedAt };
      });
      return sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof OpError) return sendJson(res, err.status, { error: err.message, code: err.code });
      throw err;
    }
  }

  return sendJson(res, 405, { error: 'method not allowed' });
}

/* ------------------------------------------------------------------ accounts */

/*
 * Passwords are PBKDF2-SHA256 with a per-user salt, compared in constant time.
 * Sessions are random tokens held in an HttpOnly cookie. public/api.php uses
 * the identical scheme and file format, so users.json and sessions.json move
 * between the two backends unchanged.
 */

const COOKIE = 'omgbb_session';
const SESSION_DAYS = 30;
const PBKDF2_ITER = 120000;
const MAX_FAILURES = 5;
const LOCKOUT_MIN = 15;

const AUTH_FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  sessions: path.join(DATA_DIR, 'sessions.json'),
};
const AUTH_DEFAULTS = {
  users: { schema: 1, allowRegistration: true, users: [] },
  sessions: { schema: 1, sessions: [], failures: [] },
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto
    .pbkdf2Sync(password, Buffer.from(salt, 'hex'), PBKDF2_ITER, 32, 'sha256')
    .toString('hex');
  return 'pbkdf2$sha256$' + PBKDF2_ITER + '$' + salt + '$' + key;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  const salt = parts[3];
  const expected = parts[4];
  if (!Number.isInteger(iterations) || iterations < 1000) return false;
  if (!/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(expected)) return false;
  const key = crypto.pbkdf2Sync(
    password,
    Buffer.from(salt, 'hex'),
    iterations,
    expected.length / 2,
    'sha256'
  );
  return safeEqual(key, Buffer.from(expected, 'hex'));
}

function safeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

/* No Secure flag: this backend is for localhost, which is plain http.
   The PHP deployment sets Secure whenever it is served over HTTPS. */
function setSessionCookie(res, token, maxAge) {
  res.setHeader(
    'Set-Cookie',
    COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge
  );
}

function pruneSessions(doc) {
  const now = nowSeconds();
  return {
    ...doc,
    sessions: (doc.sessions || []).filter((s) => s.expiresAt > now),
    failures: (doc.failures || []).filter((f) => f.until > now),
  };
}

async function startSessionFor(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = nowSeconds() + SESSION_DAYS * 86400;
  const doc = pruneSessions(await readJsonFile(AUTH_FILES.sessions, AUTH_DEFAULTS.sessions));
  doc.sessions.push({ token, userId, expiresAt });
  await writeJsonFile(AUTH_FILES.sessions, doc);
  setSessionCookie(res, token, SESSION_DAYS * 86400);
}

async function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const doc = await readJsonFile(AUTH_FILES.sessions, AUTH_DEFAULTS.sessions);
  const now = nowSeconds();
  const session = (doc.sessions || []).find(
    (s) => s.expiresAt > now && safeEqual(String(s.token), token)
  );
  if (!session) return null;
  const users = await readJsonFile(AUTH_FILES.users, AUTH_DEFAULTS.users);
  return (users.users || []).find((u) => u.id === session.userId) || null;
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, username: user.username, owner: Boolean(user.owner) };
}

/** Crude brute-force brake: five bad tries park that username for a while. */
async function lockoutRemaining(username) {
  const doc = await readJsonFile(AUTH_FILES.sessions, AUTH_DEFAULTS.sessions);
  const now = nowSeconds();
  const hit = (doc.failures || []).find(
    (f) => f.username === username && f.count >= MAX_FAILURES && f.until > now
  );
  return hit ? Math.ceil((hit.until - now) / 60) : 0;
}

async function recordFailure(username) {
  const doc = pruneSessions(await readJsonFile(AUTH_FILES.sessions, AUTH_DEFAULTS.sessions));
  const existing = doc.failures.find((f) => f.username === username);
  if (existing) {
    existing.count += 1;
    existing.until = nowSeconds() + LOCKOUT_MIN * 60;
  } else {
    doc.failures.push({ username, count: 1, until: nowSeconds() + LOCKOUT_MIN * 60 });
  }
  await writeJsonFile(AUTH_FILES.sessions, doc);
}

async function clearFailures(username) {
  const doc = pruneSessions(await readJsonFile(AUTH_FILES.sessions, AUTH_DEFAULTS.sessions));
  doc.failures = doc.failures.filter((f) => f.username !== username);
  await writeJsonFile(AUTH_FILES.sessions, doc);
}

async function jsonBody(req) {
  try {
    const parsed = JSON.parse(await readBody(req));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function handleAuth(req, res, route) {
  const usersDoc = await readJsonFile(AUTH_FILES.users, AUTH_DEFAULTS.users);
  const needsSetup = (usersDoc.users || []).length === 0;
  const isWrite = req.method === 'POST' || req.method === 'PUT';

  if (route === 'me') {
    const user = await currentUser(req);
    return sendJson(res, 200, {
      authenticated: Boolean(user),
      user: publicUser(user),
      needsSetup,
      registrationOpen: needsSetup || Boolean(usersDoc.allowRegistration),
    });
  }

  if (route === 'logout') {
    const token = readCookie(req, COOKIE);
    if (token) {
      const doc = pruneSessions(await readJsonFile(AUTH_FILES.sessions, AUTH_DEFAULTS.sessions));
      doc.sessions = doc.sessions.filter((s) => !safeEqual(String(s.token), token));
      await writeJsonFile(AUTH_FILES.sessions, doc);
    }
    setSessionCookie(res, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  if (!isWrite) return sendJson(res, 405, { error: 'method not allowed' });

  const body = await jsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'expected a JSON object' });

  if (route === 'register') {
    if (!needsSetup && !usersDoc.allowRegistration) {
      return sendJson(res, 403, { error: 'Registration is closed on this site.' });
    }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      return sendJson(res, 400, {
        error: 'Username must be 3-32 characters: letters, digits, dot, dash or underscore.',
      });
    }
    if (password.length < 8) {
      return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
    }
    if ((usersDoc.users || []).some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { error: 'That username is taken.' });
    }
    const user = {
      id: 'u' + crypto.randomBytes(8).toString('hex'),
      username,
      hash: hashPassword(password),
      owner: needsSetup,
      createdAt: new Date().toISOString(),
    };
    usersDoc.users.push(user);
    // The first account owns the site; nobody else joins unless invited.
    if (needsSetup) usersDoc.allowRegistration = false;
    await backup(AUTH_FILES.users);
    await writeJsonFile(AUTH_FILES.users, usersDoc);
    await startSessionFor(res, user.id);
    return sendJson(res, 200, {
      ok: true,
      user: publicUser(user),
      registrationOpen: Boolean(usersDoc.allowRegistration),
    });
  }

  if (route === 'login') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const key = username.toLowerCase();
    const locked = await lockoutRemaining(key);
    if (locked > 0) {
      return sendJson(res, 429, {
        error: 'Too many attempts. Try again in ' + locked + ' minute(s).',
      });
    }
    const user = (usersDoc.users || []).find(
      (u) => u.username.toLowerCase() === key && verifyPassword(password, u.hash)
    );
    if (!user) {
      await recordFailure(key);
      return sendJson(res, 401, { error: 'Wrong username or password.' });
    }
    await clearFailures(key);
    await startSessionFor(res, user.id);
    return sendJson(res, 200, {
      ok: true,
      user: publicUser(user),
      registrationOpen: Boolean(usersDoc.allowRegistration),
    });
  }

  if (route === 'settings') {
    const user = await currentUser(req);
    if (!user || !user.owner) {
      return sendJson(res, 403, { error: 'Only the site owner can change this.' });
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'allowRegistration')) {
      return sendJson(res, 400, { error: 'expected {"allowRegistration": true|false}' });
    }
    usersDoc.allowRegistration = Boolean(body.allowRegistration);
    await writeJsonFile(AUTH_FILES.users, usersDoc);
    return sendJson(res, 200, { ok: true, registrationOpen: usersDoc.allowRegistration });
  }

  return sendJson(res, 404, { error: 'unknown route' });
}

/* ------------------------------------------------------------ static files */

async function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  // These are for the PHP deployment; never hand them out as text.
  if (/(^|[\/])(\.htaccess|.*\.php)$/i.test(rel)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/* ----------------------------------------------------------------- routing */

const server = http.createServer(async (req, res) => {
  res.setHeader('X-OMGBB-Api', String(API_VERSION));
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  // The PHP deployment is reachable as api.php?route=x when mod_rewrite is
  // unavailable; accept the same shape here so the client behaves identically.
  let pathname = url.pathname;
  if (pathname === '/api.php' && url.searchParams.has('route')) {
    pathname = '/api/' + url.searchParams.get('route');
  }
  try {
    const authMatch = pathname.match(/^\/api\/(me|login|logout|register|settings)$/);
    if (authMatch) {
      return await handleAuth(req, res, authMatch[1]);
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      // Reachable without a session so a deployment can be checked; anything
      // that would leak paths or activity needs one.
      const signedIn = Boolean(await currentUser(req));
      const payload = {
        ok: true,
        backend: 'node',
        nodeVersion: process.version,
        dataDirWritable: true,
        httpClient: 'fetch',
        authenticated: signedIn,
      };
      if (signedIn) {
        let cachedPages = 0;
        try {
          cachedPages = (await fsp.readdir(CACHE_DIR)).length;
        } catch {
          cachedPages = 0;
        }
        Object.assign(payload, {
          dataDir: DATA_DIR,
          cachedPages,
          upstreamRequests: upstream.total,
          cacheHits: upstream.cacheHits,
          hourlyBudgetLeft: budgetLeft(),
        });
      }
      return sendJson(res, 200, payload);
    }

    // Everything past this point is private.
    if (pathname.startsWith('/api/') && !(await currentUser(req))) {
      return sendJson(res, 401, { error: 'Sign in first.' });
    }

    if (pathname === '/api/wiki' && req.method === 'GET') {
      return await handleWiki(req, res, url);
    }

    if (pathname === '/api/collection') {
      return await handleCollection(req, res, url);
    }

    if (pathname === '/api/users' && req.method === 'GET') {
      return await handleUsers(req, res);
    }

    const storeMatch = pathname.match(/^\/api\/(index)$/);
    if (storeMatch) {
      const which = storeMatch[1];
      const file = FILES[which];
      if (req.method === 'GET') {
        return sendJson(res, 200, await readJsonFile(file, DEFAULTS[which]));
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        try {
          const ops = parseOps(await readBody(req));
          const result = await withFileLock(file, async () => {
            const current = await readJsonFile(file, DEFAULTS[which]);
            const doc = applyIndexOps(structuredClone(current), ops);
            doc.updatedAt = new Date().toISOString();
            await backup(file);
            await writeJsonFile(file, doc);
            return { ok: true, updatedAt: doc.updatedAt };
          });
          return sendJson(res, 200, result);
        } catch (err) {
          if (err instanceof OpError) return sendJson(res, err.status, { error: err.message, code: err.code });
          throw err;
        }
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

fs.mkdirSync(DATA_DIR, { recursive: true });
server.listen(PORT, () => {
  console.log('\n  OMGBBManager running at  http://localhost:' + PORT);
  console.log('  Data:                    ' + DATA_DIR);
  console.log('  Wiki cache:              ' + CACHE_DIR + '\n');
});
