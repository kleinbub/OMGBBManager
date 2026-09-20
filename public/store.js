/**
 * Collection state: load, mutate, persist, aggregate.
 *
 * Every change is sent to the server as a small operation - "put this entry",
 * "remove that one", "put this part" - which the server merges into the shelf
 * under a lock. Small requests stay far below shared-host body limits, and tabs
 * cannot overwrite each other's work because nobody uploads a whole, possibly
 * stale, shelf any more. Operations the server has not accepted yet are kept in
 * localStorage, so they survive a reload and are retried.
 */

import { normalizeKey, partKey, integratedExtra, PART_KINDS, ratchetShape } from './parse.js';
import { apiFetch } from './api.js';

/* The whole-shelf mirror older versions kept; read once to recover lost changes. */
const LEGACY_KEY = 'omgbb.collection.v1';
const EMPTY = { schema: 1, updatedAt: null, beyblades: [], parts: {}, combos: [] };
const BATCH_BYTES = 12000;
const BATCH_OPS = 40;
const PRODUCTS_PER_REQUEST = 100;

export const store = {
  data: structuredClone(EMPTY),
  index: { schema: 1, updatedAt: null, categories: {} },
  users: [],
  /* Whose shelf is on screen. Someone else's is always read-only. */
  viewing: { userId: null, username: null, isSelf: true },
  selfId: null,
  serverAvailable: false,
  /* 2 = the server merges operations; 1 = an older server that takes whole documents. */
  apiVersion: 1,
  /* What the server last confirmed for the signed-in blader's own shelf. */
  revision: 0,
  serverUpdatedAt: null,
  /* Operations the server has not accepted yet, oldest first. */
  pending: [],
  saveState: { status: 'idle', message: '', code: null },
  /* Beyblades an older version of the app saved only in this browser. */
  recovery: null,
  /* Bumped whenever data arrives from outside this tab, so the page can redraw. */
  shelfEpoch: 0,
  indexEpoch: 0,
  listeners: new Set(),
};

export function onChange(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

function emit() {
  for (const fn of store.listeners) fn(store);
}

/* -------------------------------------------------------------------- tabs */

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('omgbb') : null;

function broadcast(message) {
  try {
    if (channel) channel.postMessage(message);
  } catch {
    /* the other tabs catch up when they are focused */
  }
}

/** Hear about saves made in other tabs of this site. */
export function onBroadcast(fn) {
  if (channel) channel.addEventListener('message', (event) => fn(event.data || {}));
}

/* ----------------------------------------------------------------- loading */

/**
 * Maps must be plain objects. An empty map that passed through an older PHP
 * backend comes back as [], and anything later stored on an array is silently
 * dropped by JSON.stringify.
 */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalise(doc) {
  const data = Object.assign(structuredClone(EMPTY), doc || {});
  if (!Array.isArray(data.beyblades)) data.beyblades = [];
  if (!Array.isArray(data.combos)) data.combos = [];
  data.parts = asObject(data.parts);
  for (const entry of data.beyblades) {
    entry.partKeys = asObject(entry.partKeys);
    if (entry.bey) entry.bey.partRefs = asObject(entry.bey.partRefs);
  }
  for (const combo of data.combos) {
    combo.partKeys = asObject(combo.partKeys);
    if (!Array.isArray(combo.tags)) combo.tags = [];
    combo.rating = Number(combo.rating) || 0;
  }
  for (const part of Object.values(data.parts)) {
    if (part) part.stats = asObject(part.stats);
  }
  // Early versions derived a letter code for every part; only bits and assist
  // blades actually have one - plus a ratchet with the bit built in, which
  // goes by that code on the box ("Tr").
  for (const part of Object.values(data.parts)) {
    if (
      part &&
      part.code &&
      part.kind !== 'bit' &&
      part.kind !== 'assistBlade' &&
      integratedExtra(part) !== 'bit'
    ) {
      part.code = null;
    }
  }
  return data;
}

function pendingKey() {
  return 'omgbb.pending.' + (store.selfId || 'anonymous');
}

function readPending() {
  try {
    const saved = JSON.parse(localStorage.getItem(pendingKey()) || 'null');
    return saved && Array.isArray(saved.pending) ? saved.pending : [];
  } catch {
    return [];
  }
}

function persistPending() {
  try {
    if (store.pending.length) {
      localStorage.setItem(
        pendingKey(),
        JSON.stringify({ savedAt: new Date().toISOString(), pending: store.pending })
      );
    } else {
      localStorage.removeItem(pendingKey());
    }
  } catch {
    /* private mode or quota: the queue still lives in memory */
  }
}

function entryIdOf(op) {
  return op.op === 'putEntry' ? op.entry && op.entry.id : op.id;
}

function comboIdOf(op) {
  return op.op === 'putCombo' ? op.combo && op.combo.id : op.id;
}

/** Apply operations to a shelf document, exactly as the server does. */
function applyOps(doc, ops) {
  let out = doc;
  for (const op of ops) {
    if (op.op === 'replace') {
      out = normalise(structuredClone(op.doc));
    } else if (op.op === 'putPart') {
      out.parts[op.key] = op.part;
    } else if (op.op === 'putEntry' || op.op === 'removeEntry') {
      const at = out.beyblades.findIndex((b) => b.id === entryIdOf(op));
      if (op.op === 'removeEntry') {
        if (at >= 0) out.beyblades.splice(at, 1);
      } else if (at >= 0) {
        out.beyblades[at] = op.entry;
      } else {
        out.beyblades.push(op.entry);
      }
    } else if (op.op === 'putCombo' || op.op === 'removeCombo') {
      if (!Array.isArray(out.combos)) out.combos = [];
      const at = out.combos.findIndex((c) => c.id === comboIdOf(op));
      if (op.op === 'removeCombo') {
        if (at >= 0) out.combos.splice(at, 1);
      } else if (at >= 0) {
        out.combos[at] = op.combo;
      } else {
        out.combos.push(op.combo);
      }
    }
  }
  return out;
}

/** Take the signed-in blader's shelf from a GET response, replaying anything unsent. */
async function adoptOwnShelf(res) {
  store.apiVersion = Number(res.headers.get('X-OMGBB-Api')) || 1;
  const doc = normalise(await res.json());
  store.revision = Number(doc.revision) || 0;
  store.serverUpdatedAt = doc.updatedAt || null;
  store.pending = readPending();
  store.data = applyOps(doc, store.pending);
}

export async function loadAll(me) {
  store.selfId = me ? me.id : null;
  store.viewing = {
    userId: me ? me.id : null,
    username: me ? me.username : null,
    isSelf: true,
  };
  try {
    // Sequential: the first call is what detects which URL shape this host needs.
    const collectionRes = await apiFetch('collection');
    const indexRes = await apiFetch('index');
    if (collectionRes.ok) {
      await adoptOwnShelf(collectionRes);
      store.serverAvailable = true;
    }
    if (indexRes.ok) store.index = await indexRes.json();
  } catch {
    store.serverAvailable = false;
  }

  if (!store.serverAvailable) {
    try {
      const local = localStorage.getItem(LEGACY_KEY);
      if (local) store.data = normalise(JSON.parse(local));
    } catch {
      /* corrupt local copy: start clean rather than crashing the app */
    }
  } else {
    detectRecovery();
    if (store.pending.length) flushSoon(0);
  }
  emit();
  return store.data;
}

/** Swap the displayed shelf. Passing null (or yourself) returns to your own. */
export async function loadCollection(user, me) {
  const isSelf = !user || !me || user.id === me.id;
  const res = await apiFetch('collection', isSelf ? {} : { params: { user: user.id } });
  if (!res.ok) {
    let message = 'Could not open that shelf.';
    try {
      message = (await res.json()).error || message;
    } catch {
      /* keep the default */
    }
    throw new Error(message);
  }
  store.viewing = {
    userId: isSelf ? (me ? me.id : null) : user.id,
    username: isSelf ? (me ? me.username : null) : user.username,
    isSelf,
  };
  if (isSelf) await adoptOwnShelf(res);
  else store.data = normalise(await res.json());
  emit();
  return store.data;
}

export async function loadUsers() {
  try {
    const res = await apiFetch('users');
    if (res.ok) store.users = (await res.json()).users || [];
  } catch {
    /* leave the previous list in place */
  }
  emit();
  return store.users;
}

/**
 * Pick up what other tabs (or other devices) saved. Pending local operations
 * are replayed on top, so nothing unsent disappears from the screen.
 */
export async function refreshOwnShelf(force = false) {
  if (!store.serverAvailable || !store.viewing.isSelf || (flushing && !force)) return false;
  let res;
  try {
    res = await apiFetch('collection');
  } catch {
    return false;
  }
  if (!res.ok) return false;
  const doc = normalise(await res.json());
  const revision = Number(doc.revision) || 0;
  if (!force && revision === store.revision && (doc.updatedAt || null) === store.serverUpdatedAt) {
    return false;
  }
  if (!store.viewing.isSelf) return false;
  store.revision = revision;
  store.serverUpdatedAt = doc.updatedAt || null;
  store.data = applyOps(doc, store.pending);
  store.shelfEpoch += 1;
  emit();
  return true;
}

export async function reloadIndex() {
  if (!store.serverAvailable) return false;
  try {
    const res = await apiFetch('index');
    if (!res.ok) return false;
    const next = await res.json();
    const stamp = (index) => (index && (index.catalogueUpdatedAt || index.updatedAt)) || null;
    if (stamp(next) === stamp(store.index) && next.productsTotal === store.index?.productsTotal) {
      return false;
    }
    store.index = next;
    store.indexEpoch += 1;
    emit();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ saving */

let flushTimer = null;
let flushing = null;

function flushSoon(delay = 300) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flush();
  }, delay);
}

/**
 * Queue operations for the server. A newer operation on the same entry or part
 * replaces an older one still waiting, so rapid clicks send one request.
 */
function queueOps(ops) {
  if (!store.viewing.isSelf) return;
  for (const raw of ops) {
    const op = structuredClone(raw);
    if (op.op === 'replace') {
      store.pending = [op];
      continue;
    }
    const comboOp = op.op === 'putCombo' || op.op === 'removeCombo';
    store.pending = store.pending.filter((queued) => {
      if (op.op === 'putPart') return !(queued.op === 'putPart' && queued.key === op.key);
      if (comboOp) {
        const sameCombo =
          (queued.op === 'putCombo' || queued.op === 'removeCombo') && comboIdOf(queued) === comboIdOf(op);
        return !sameCombo;
      }
      const sameEntry =
        (queued.op === 'putEntry' || queued.op === 'removeEntry') && entryIdOf(queued) === entryIdOf(op);
      return !sameEntry;
    });
    store.pending.push(op);
  }
  if (store.saveState.status === 'error' && store.saveState.code !== 'stale-client') {
    store.saveState = { status: 'idle', message: '', code: null };
  }
  persistPending();
  emit();
  flushSoon();
}

function takeBatch() {
  if (store.pending[0].op === 'replace') return [store.pending[0]];
  const batch = [];
  let bytes = 0;
  for (const op of store.pending) {
    if (op.op === 'replace') break;
    const size = JSON.stringify(op).length;
    if (batch.length && (bytes + size > BATCH_BYTES || batch.length >= BATCH_OPS)) break;
    batch.push(op);
    bytes += size;
  }
  return batch;
}

/** Turn a refused request into a message that says what failed and why. */
async function describeFailure(res, batch, what = null) {
  const text = await res.text().catch(() => '');
  let detail = '';
  let code = null;
  try {
    const parsed = JSON.parse(text);
    detail = parsed.error || '';
    code = parsed.code || null;
  } catch {
    // Not our JSON: a proxy, firewall or size-limit page. Keep its gist.
    detail = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  if (code === 'stale-client') {
    return { status: 'error', message: detail || 'This page is out of date. Reload it.', code };
  }
  const names = batch.filter((op) => op.op === 'putEntry' && op.entry).map((op) => op.entry.displayName);
  const subject =
    what ||
    (batch.some((op) => op.op === 'replace')
      ? 'the imported shelf'
      : names.length
        ? names.slice(0, 3).join(', ') + (names.length > 3 ? ' and ' + (names.length - 3) + ' more' : '')
        : 'your latest change');
  return {
    status: 'error',
    message: 'Could not save ' + subject + ': HTTP ' + res.status + (detail ? ' - ' + detail : '') + '.',
    code: code || 'http-' + res.status,
  };
}

async function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    let gap = false;
    while (store.pending.length && store.serverAvailable && store.saveState.status !== 'error') {
      const legacy = store.apiVersion < 2;
      // An older server only takes the whole shelf, which must then be our own.
      if (legacy && !store.viewing.isSelf) break;
      const batch = legacy ? store.pending.slice() : takeBatch();
      const body = legacy ? store.data : { ops: batch };

      store.saveState = { status: 'saving', message: '', code: null };
      emit();
      let res;
      try {
        res = await apiFetch('collection', { method: 'POST', body: JSON.stringify(body) });
      } catch {
        store.saveState = { status: 'error', message: 'The server did not answer.', code: 'network' };
        break;
      }
      if (!res.ok) {
        store.saveState = await describeFailure(res, batch);
        break;
      }
      const result = await res.json().catch(() => ({}));
      if (typeof result.revision === 'number') {
        // A jump means another tab or device saved in between: fetch its changes.
        if (result.revision !== store.revision + 1) gap = true;
        store.revision = result.revision;
      }
      if (result.updatedAt) {
        store.serverUpdatedAt = result.updatedAt;
        store.data.updatedAt = result.updatedAt;
      }
      const sent = new Set(batch);
      store.pending = store.pending.filter((op) => !sent.has(op));
      persistPending();
      broadcast({ type: 'shelf-saved', userId: store.selfId });
      if (store.saveState.status === 'saving') store.saveState = { status: 'idle', message: '', code: null };
    }
    if (!store.pending.length) store.saveState = { status: 'idle', message: '', code: null };
    emit();
    if (gap) await refreshOwnShelf(true);
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
    if (store.pending.length && store.saveState.status !== 'error') flushSoon();
  }
}

/** Send whatever is still queued. Waits until it has been accepted or refused. */
export async function flushNow() {
  clearTimeout(flushTimer);
  await flush();
}

export function retrySave() {
  if (!store.pending.length || store.saveState.code === 'stale-client') return;
  store.saveState = { status: 'idle', message: '', code: null };
  emit();
  flush();
}

/**
 * Save a freshly built catalogue in small pieces: one request per part kind,
 * the product list in chunks, then the stamp that marks it complete.
 */
export async function saveIndex(index, { onProgress = () => {} } = {}) {
  const products = Array.isArray(index.products) ? index.products : [];
  const complete = { ...index, productsTotal: products.length };
  if (!store.serverAvailable) {
    store.index = complete;
    store.indexEpoch += 1;
    emit();
    return;
  }

  const send = async (body, what) => {
    const res = await apiFetch('index', { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await describeFailure(res, [], what)).message);
  };

  if (store.apiVersion < 2) {
    onProgress('Saving the catalogue...');
    await send(complete, 'the catalogue');
  } else {
    const kinds = Object.entries(index.categories || {});
    const chunks = Math.max(1, Math.ceil(products.length / PRODUCTS_PER_REQUEST));
    const steps = kinds.length + chunks + 1;
    let step = 0;
    const progress = () => onProgress('Saving the catalogue (' + ++step + '/' + steps + ')...');
    for (const [kind, items] of kinds) {
      progress();
      await send({ ops: [{ op: 'setCategory', kind, items }] }, 'the catalogue (' + kind + ')');
    }
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      const start = chunk * PRODUCTS_PER_REQUEST;
      progress();
      await send(
        {
          ops: [
            {
              op: 'setProducts',
              start,
              total: products.length,
              items: products.slice(start, start + PRODUCTS_PER_REQUEST),
            },
          ],
        },
        'the catalogue (products)'
      );
    }
    progress();
    await send(
      {
        ops: [
          {
            op: 'finish',
            schema: index.schema || 2,
            productsTotal: products.length,
            catalogueUpdatedAt: index.catalogueUpdatedAt || new Date().toISOString(),
          },
        ],
      },
      'the catalogue'
    );
  }

  store.index = complete;
  store.indexEpoch += 1;
  emit();
  broadcast({ type: 'index-saved' });
}

/* ---------------------------------------------------------------- recovery */

/**
 * Older versions mirrored the whole shelf in localStorage before every save,
 * even saves the server then refused. Entries there that the server never got
 * are offered back by name.
 */
function detectRecovery() {
  store.recovery = null;
  if (!store.viewing.isSelf) return;
  let legacy = null;
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
  } catch {
    legacy = null;
  }
  if (!legacy || !Array.isArray(legacy.beyblades)) return;

  const onServer = new Set(store.data.beyblades.map((b) => b.id));
  const entries = legacy.beyblades.filter((b) => b && b.id && b.bey && !onServer.has(b.id));
  if (!entries.length) {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* nothing to recover either way */
    }
    return;
  }
  const parts = {};
  for (const entry of entries) {
    for (const key of Object.values(entry.partKeys || {})) {
      if (legacy.parts && legacy.parts[key]) parts[key] = legacy.parts[key];
    }
  }
  store.recovery = { entries, parts };
}

export function restoreRecovery() {
  if (!store.recovery) return;
  const { entries, parts } = store.recovery;
  store.recovery = null;
  const ops = [];
  for (const [key, part] of Object.entries(parts)) {
    store.data.parts[key] = part;
    ops.push({ op: 'putPart', key, part });
  }
  for (const entry of entries) {
    if (!store.data.beyblades.some((b) => b.id === entry.id)) store.data.beyblades.push(entry);
    ops.push({ op: 'putEntry', entry });
  }
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* already queued for the server */
  }
  queueOps(ops);
}

export function discardRecovery() {
  store.recovery = null;
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* nothing stored */
  }
  emit();
}

/* ----------------------------------------------------------------- mutation */

/** Entries written before the wishlist existed have no status: they are owned. */
export function isWish(entry) {
  return Boolean(entry) && entry.status === 'wish';
}

function newId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Operations that put an entry - and, when asked, its part records - on the server. */
function entryOps(entry, withParts) {
  const ops = [];
  if (withParts) {
    for (const key of Object.values(entry.partKeys || {})) {
      const part = store.data.parts[key];
      if (part) ops.push({ op: 'putPart', key, part });
    }
  }
  ops.push({ op: 'putEntry', entry });
  return ops;
}

/** Store a fetched beyblade plus its parts, replacing any earlier copy of the same product. */
export function addBeyblade({
  input,
  bey,
  parts,
  qty = 1,
  notes = '',
  id = null,
  status = 'owned',
}) {
  const partKeys = {};
  for (const [kind, part] of Object.entries(parts || {})) {
    const key = partKey(kind, part.name);
    store.data.parts[key] = part;
    partKeys[kind] = key;
  }

  const entry = {
    id: id || newId(),
    input,
    displayName: bey.hasbroName || bey.wikiName || input,
    qty: Number(qty) || 1,
    notes,
    status: status === 'wish' ? 'wish' : 'owned',
    addedAt: new Date().toISOString(),
    bey,
    partKeys,
  };

  const existing = store.data.beyblades.findIndex((b) => b.id === entry.id);
  if (existing >= 0) {
    const previous = store.data.beyblades[existing];
    entry.addedAt = previous.addedAt;
    if (previous.wishedAt) entry.wishedAt = previous.wishedAt;
    if (isWish(previous) && entry.status === 'owned') {
      // A wish coming true: it joins the collection today.
      entry.wishedAt = previous.addedAt;
      entry.addedAt = new Date().toISOString();
    }
    store.data.beyblades[existing] = entry;
  } else {
    store.data.beyblades.push(entry);
  }
  queueOps(entryOps(entry, true));
  return entry;
}

export function updateBeyblade(id, patch) {
  const entry = store.data.beyblades.find((b) => b.id === id);
  if (!entry) return null;
  Object.assign(entry, patch);
  queueOps(entryOps(entry, false));
  return entry;
}

/** Move a wishlist entry into the collection. */
export function acquireBeyblade(id) {
  const entry = store.data.beyblades.find((b) => b.id === id);
  if (!isWish(entry)) return null;
  entry.status = 'owned';
  entry.wishedAt = entry.addedAt;
  entry.addedAt = new Date().toISOString();
  queueOps(entryOps(entry, false));
  return entry;
}

/** Put an owned beyblade back on the wishlist - the other way round from acquire. */
export function wishBeyblade(id) {
  const entry = store.data.beyblades.find((b) => b.id === id);
  if (!entry || isWish(entry)) return null;
  entry.status = 'wish';
  entry.wishedAt = new Date().toISOString();
  queueOps(entryOps(entry, false));
  return entry;
}

export function removeBeyblade(id) {
  store.data.beyblades = store.data.beyblades.filter((b) => b.id !== id);
  queueOps([{ op: 'removeEntry', id }]);
}

/** Keep details for a part that no beyblade on the shelf uses yet. */
export function putPart(key, part) {
  store.data.parts[key] = part;
  queueOps([{ op: 'putPart', key, part }]);
}

export function getPart(key) {
  return store.data.parts[key] || null;
}

export function partsOf(entry) {
  const out = {};
  for (const [kind, key] of Object.entries(entry.partKeys || {})) {
    const part = store.data.parts[key];
    if (part) out[kind] = part;
  }
  return out;
}

/* ----------------------------------------------------------- custom combos */

/*
 * A combination is a set of parts the blader put together, not a product:
 * it points at the same part records the shelf already holds, and adds the
 * notes, tags and rating that come out of actually battling with it.
 */

function comboId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function cleanTags(tags) {
  const seen = [];
  for (const raw of Array.isArray(tags) ? tags : String(tags || '').split(',')) {
    const tag = String(raw || '').trim().toLowerCase().slice(0, 24);
    if (tag && !seen.includes(tag)) seen.push(tag);
  }
  return seen.slice(0, 8);
}

/** Create or update a combination. Returns the stored record. */
export function saveCombo(input) {
  const now = new Date().toISOString();
  const existing = input.id ? store.data.combos.find((c) => c.id === input.id) : null;
  const combo = {
    id: existing ? existing.id : comboId(),
    name: input.name || '',
    nickname: String(input.nickname || '').trim().slice(0, 60),
    lead: input.lead || 'blade',
    line: input.line || '',
    partKeys: { ...(input.partKeys || {}) },
    tags: cleanTags(input.tags),
    rating: Math.max(0, Math.min(5, Math.round(Number(input.rating) || 0))),
    strengths: String(input.strengths || '').trim(),
    weaknesses: String(input.weaknesses || '').trim(),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  if (existing) store.data.combos[store.data.combos.indexOf(existing)] = combo;
  else store.data.combos.push(combo);
  queueOps([{ op: 'putCombo', combo }]);
  return combo;
}

/** Change a few fields of a combination - a rating, say - and save it. */
export function updateCombo(id, patch) {
  const combo = store.data.combos.find((c) => c.id === id);
  if (!combo) return null;
  return saveCombo({ ...combo, ...patch });
}

export function removeCombo(id) {
  store.data.combos = store.data.combos.filter((c) => c.id !== id);
  queueOps([{ op: 'removeCombo', id }]);
}

export function comboPartsOf(combo) {
  return partsOf(combo);
}

/** Every tag in use on this shelf, most used first. */
export function comboTags() {
  const counts = new Map();
  for (const combo of store.data.combos) {
    for (const tag of combo.tags || []) bump(counts, tag);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* --------------------------------------------------------------- aggregates */

/**
 * Every part on the shelf, owned or wished for. `count` is what is physically
 * there; `wishCount` is what the wishlist would add.
 */
export function partInventory() {
  const inventory = new Map();
  for (const entry of store.data.beyblades) {
    const qty = Number(entry.qty) || 1;
    const wish = isWish(entry);
    for (const [kind, key] of Object.entries(entry.partKeys || {})) {
      const part = store.data.parts[key];
      if (!part) continue;
      if (!inventory.has(key)) {
        inventory.set(key, { key, kind, part, count: 0, wishCount: 0, sources: [] });
      }
      const record = inventory.get(key);
      if (wish) record.wishCount += qty;
      else record.count += qty;
      record.sources.push({
        id: entry.id,
        name: entry.displayName,
        qty,
        status: wish ? 'wish' : 'owned',
      });
    }
  }
  return inventory;
}

export function inventoryByKind() {
  const grouped = Object.fromEntries(PART_KINDS.map((k) => [k, []]));
  for (const record of partInventory().values()) {
    (grouped[record.kind] = grouped[record.kind] || []).push(record);
  }
  for (const kind of Object.keys(grouped)) {
    grouped[kind].sort((a, b) => {
      if (kind === 'ratchet') {
        const sa = ratchetShape(a.part.name);
        const sb = ratchetShape(b.part.name);
        return (sa.height - sb.height) || String(sa.contacts).localeCompare(String(sb.contacts));
      }
      return (a.part.hasbroName || a.part.name).localeCompare(b.part.hasbroName || b.part.name);
    });
  }
  return grouped;
}

/** Sum of the wiki stat values of the parts that make up one beyblade. */
export function combinedStats(entry) {
  const totals = { attack: 0, defense: 0, stamina: 0, dash: 0, burst: 0 };
  let contributors = 0;
  for (const part of Object.values(partsOf(entry))) {
    const stats = part.stats || {};
    let counted = false;
    for (const key of Object.keys(totals)) {
      if (typeof stats[key] === 'number') {
        totals[key] += stats[key];
        counted = true;
      }
    }
    if (counted) contributors += 1;
  }
  return contributors ? { ...totals, contributors } : null;
}

function bump(map, key, by = 1) {
  if (key === null || key === undefined || key === '') return;
  map.set(key, (map.get(key) || 0) + by);
}

/** Analysis describes what is owned; the wishlist is only counted. */
export function distribution() {
  const beys = store.data.beyblades.filter((b) => !isWish(b));
  const wishlistProducts = store.data.beyblades.length - beys.length;
  const totalUnits = beys.reduce((sum, b) => sum + (Number(b.qty) || 1), 0);

  const beyTypes = new Map();
  const beySystems = new Map();
  const beySeries = new Map();
  const spin = new Map();
  const hasbro = new Map();
  const partTypes = Object.fromEntries(PART_KINDS.map((k) => [k, new Map()]));
  const ratchetHeights = new Map();
  const ratchetContacts = new Map();
  const bitUsage = new Map();
  const bladeUsage = new Map();

  let weightSum = 0;
  let weightCount = 0;
  const statTotals = { attack: 0, defense: 0, stamina: 0 };
  let statCount = 0;

  for (const entry of beys) {
    const qty = Number(entry.qty) || 1;
    const bey = entry.bey || {};
    bump(beyTypes, bey.type || 'Unknown', qty);
    bump(beySystems, bey.system || 'Unknown', qty);
    bump(beySeries, bey.series || 'Unknown', qty);
    bump(spin, bey.spinDirection || 'Unknown', qty);
    bump(hasbro, bey.hasbroReleased ? 'Hasbro release' : 'Import / TT only', qty);

    if (typeof bey.weight === 'number') {
      weightSum += bey.weight * qty;
      weightCount += qty;
    }

    const stats = combinedStats(entry);
    if (stats) {
      statTotals.attack += stats.attack * qty;
      statTotals.defense += stats.defense * qty;
      statTotals.stamina += stats.stamina * qty;
      statCount += qty;
    }

    for (const [kind, part] of Object.entries(partsOf(entry))) {
      bump(partTypes[kind], part.type || 'Unrated', qty);
      if (kind === 'ratchet') {
        const shape = ratchetShape(part.name);
        bump(ratchetHeights, shape.height ? shape.height + ' mm' : 'Unknown', qty);
        bump(ratchetContacts, shape.contacts !== null ? String(shape.contacts) : 'Unknown', qty);
      }
      // Hasbro names where Hasbro has one: this is a Hasbro collection.
      const label = part.hasbroName || part.name;
      if (kind === 'bit') bump(bitUsage, label, qty);
      if (kind === 'blade' || kind === 'mainBlade' || kind === 'metalBlade') {
        bump(bladeUsage, label, qty);
      }
    }
  }

  const inventory = [...partInventory().values()];
  const uniqueParts = Object.fromEntries(
    PART_KINDS.map((k) => [k, inventory.filter((r) => r.kind === k && r.count > 0).length])
  );
  const indexTotals = Object.fromEntries(
    PART_KINDS.map((k) => {
      const listed = store.index?.categories?.[k] || [];
      const names = new Set(listed.map((p) => normalizeKey(p.name)));
      return [k, names.size];
    })
  );

  return {
    totalProducts: beys.length,
    wishlistProducts,
    totalUnits,
    beyTypes,
    beySystems,
    beySeries,
    spin,
    hasbro,
    partTypes,
    ratchetHeights,
    ratchetContacts,
    bitUsage,
    bladeUsage,
    uniqueParts,
    indexTotals,
    averageWeight: weightCount ? weightSum / weightCount : null,
    averageStats: statCount
      ? {
          attack: statTotals.attack / statCount,
          defense: statTotals.defense / statCount,
          stamina: statTotals.stamina / statCount,
        }
      : null,
  };
}

/* ------------------------------------------------------------ import/export */

export function exportJson() {
  return JSON.stringify(store.data, null, 2);
}

export async function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.beyblades)) {
    throw new Error('That file does not look like an OMGBBManager collection.');
  }
  const doc = normalise(parsed);
  delete doc.revision;
  store.data = doc;
  // Emptying the shelf is only allowed against the revision this page saw. The
  // imported contents then follow as ordinary small operations, so an import is
  // never one oversized request.
  const { beyblades, parts, combos, ...meta } = doc;
  queueOps([
    { op: 'replace', doc: { ...meta, beyblades: [], parts: {}, combos: [] }, baseRevision: store.revision },
    ...Object.entries(parts).map(([key, part]) => ({ op: 'putPart', key, part })),
    ...beyblades.map((entry) => ({ op: 'putEntry', entry })),
    ...combos.map((combo) => ({ op: 'putCombo', combo })),
  ]);
  await flushNow();
  return store.data;
}
