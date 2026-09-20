/**
 * OMGBBManager - views and interaction.
 *
 * Three views: the collection itself, the parts breakdown, and the analysis of
 * how the collection is distributed.
 */

import {
  PART_KINDS,
  PART_LABELS,
  COMBO_LINES,
  COMBO_LEAD_KINDS,
  comboSlots,
  comboName,
  integratedExtra,
  normalizeKey,
  ratchetShape,
} from './parse.js';
import { fetchBeyblade, fetchPart, fetchPartIndex, wikiUrl } from './wiki.js';
import {
  auth,
  refreshSession,
  submitCredentials,
  logout,
  setRegistrationOpen,
  sessionLost,
  authScreen,
} from './auth.js';
import {
  store,
  onChange,
  loadAll,
  loadCollection,
  loadUsers,
  saveIndex,
  putPart,
  retrySave,
  restoreRecovery,
  discardRecovery,
  refreshOwnShelf,
  reloadIndex,
  onBroadcast,
  addBeyblade,
  acquireBeyblade,
  wishBeyblade,
  isWish,
  updateBeyblade,
  removeBeyblade,
  partsOf,
  partInventory,
  inventoryByKind,
  saveCombo,
  updateCombo,
  removeCombo,
  comboTags,
  combinedStats,
  distribution,
  exportJson,
  importJson,
} from './store.js';

const TYPE_ORDER = ['Attack', 'Defense', 'Stamina', 'Balance'];

const ui = {
  view: 'collection',
  partKind: 'blade',
  showUnowned: false,
  search: '',
  typeFilter: 'all',
  shelfFilter: 'all', // 'all' | 'owned' | 'wish'
  statsMode: readStatsMode(), // 'bars' | 'radar'
  sort: 'added-desc',
  comboFilter: [], // tags to show; empty means every combo
  comboSort: 'rating-desc',
  builder: null, // the combo being put together, see newBuilder()
  busy: false,
  progress: '',
  input: '',
  pending: null, // { input, bey, parts, qty, notes }
  choices: null, // wiki search results awaiting a pick
  error: '',
  detailId: null,
  cataloguePromptLater: readLater(),
};

/* Bars or radar: a per-browser preference, like a remembered tab. */
function readStatsMode() {
  try {
    return localStorage.getItem('omgbb.statsMode') === 'radar' ? 'radar' : 'bars';
  } catch {
    return 'bars';
  }
}

/* "Later" on the stale-catalogue prompt lasts for this browser session. */
function readLater() {
  try {
    return sessionStorage.getItem('omgbb.catalogueLater') === '1';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ helpers */

const root = document.getElementById('app');

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function typeClass(type) {
  const key = String(type || '').toLowerCase();
  return TYPE_ORDER.some((t) => t.toLowerCase() === key) ? 'type-' + key : 'type-unknown';
}

function badge(type) {
  return '<span class="badge ' + typeClass(type) + '">' + esc(type || 'Unrated') + '</span>';
}

/** Hasbro renames a lot of parts (DranSword -> Sword Dran); show their name first. */
function partName(part) {
  return part?.hasbroName || part?.name || '';
}

/** The wiki/Takara Tomy name, when it differs from the Hasbro one. */
function partAltName(part) {
  return part?.hasbroName && part.hasbroName !== part.name ? part.name : '';
}

/** Fused pieces: say what else comes built into them. */
function integratedNote(part) {
  const extra = integratedExtra(part);
  if (!extra) return '';
  return (
    ' <small class="tt-name" title="' + esc(part.classification) + '">' + extra + ' included</small>'
  );
}

/** The part's own picture from the wiki, or an empty frame in its place. */
function partThumb(part) {
  return part?.image
    ? '<img class="part-thumb" src="' + esc(part.image) + '" alt="" loading="lazy">'
    : '<span class="part-thumb ph"></span>';
}

function codeChip(part) {
  return part?.code ? ' <span class="code">' + esc(part.code) + '</span>' : '';
}

/** Compact "Rhino / Reaper / Charge / 4-55 / Dot" summary line. */
function partSummary(parts) {
  return PART_KINDS.filter((k) => parts[k])
    .map((k) => esc(partName(parts[k])))
    .join(' <span class="sep">/</span> ');
}

function statRow(label, value, max, cls) {
  const width = max > 0 ? Math.min(100, Math.max(2, Math.round((value / max) * 100))) : 0;
  return (
    '<div class="stat-row"><span class="stat-label">' + esc(label) + '</span>' +
    '<span class="stat-track"><span class="stat-fill ' + cls + '" style="width:' + width + '%"></span></span>' +
    '<span class="stat-value">' + (value === null ? '-' : Math.round(value)) + '</span></div>'
  );
}

/*
 * Everything the chart draws, added up: one number to compare whole
 * combinations by. Height is left out - it says how tall a part is, not how
 * much it brings to a battle.
 */
const POWER_STATS = ['attack', 'defense', 'stamina', 'dash', 'burst'];

function statTotal(stats) {
  if (!stats) return null;
  return POWER_STATS.reduce((sum, key) => sum + (typeof stats[key] === 'number' ? stats[key] : 0), 0);
}

function powerRow(stats) {
  const total = statTotal(stats);
  if (!total) return '';
  return (
    '<div class="stat-row stat-power" title="Every stat added up">' +
    '<span class="stat-label">PWR</span><span class="stat-power-rule"></span>' +
    '<span class="stat-value">' + Math.round(total) + '</span></div>'
  );
}

function statBlockHtml(stats, max) {
  if (!stats) return '<p class="muted small">No stats on the wiki for these parts.</p>';
  const ceiling = max || statCeiling([stats]);
  let html = '<div class="stats">';
  html += statRow('ATK', stats.attack, ceiling, 'fill-attack');
  html += statRow('DEF', stats.defense, ceiling, 'fill-defense');
  html += statRow('STA', stats.stamina, ceiling, 'fill-stamina');
  if (typeof stats.dash === 'number' && stats.dash > 0) {
    html += statRow('DASH', stats.dash, ceiling, 'fill-dash');
  }
  if (typeof stats.burst === 'number' && stats.burst > 0) {
    html += statRow('BRST', stats.burst, ceiling, 'fill-burst');
  }
  return html + powerRow(stats) + '</div>';
}

const RADAR_AXES = [
  ['attack', 'ATK'],
  ['defense', 'DEF'],
  ['stamina', 'STA'],
  ['dash', 'DASH'],
  ['burst', 'BRST'],
];

/**
 * The same numbers as the bars, as a radar. Every card shares one scale, so
 * shapes compare across the collection. DASH and BRST axes join only when the
 * parts carry those stats; otherwise it stays a triangle.
 */
function radarHtml(stats, max, type) {
  if (!stats) return statBlockHtml(stats, max);
  const ceiling = max || statCeiling([stats]);
  const axes = RADAR_AXES.filter((axis, i) => i < 3 || stats.dash > 0 || stats.burst > 0);
  const n = axes.length;
  const cx = 120;
  const cy = 100;
  // The drawing box below hugs a five-axis chart of this radius and its labels.
  // It is the same on every card, so shapes stay comparable between cards.
  const radius = 72;
  const at = (i, frac) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [cx + Math.cos(angle) * radius * frac, cy + Math.sin(angle) * radius * frac];
  };
  const points = (fracs) => fracs.map((f, i) => at(i, f).map((v) => v.toFixed(1)).join(',')).join(' ');

  const values = axes.map(([key]) => (typeof stats[key] === 'number' ? stats[key] : 0));
  const fracs = values.map((v) => Math.max(0.02, Math.min(1, v / ceiling)));

  const rings = [1 / 3, 2 / 3, 1]
    .map((f) => '<polygon class="radar-ring' + (f === 1 ? ' outer' : '') + '" points="' + points(axes.map(() => f)) + '"/>')
    .join('');
  const spokes = axes
    .map((axis, i) => {
      const [x, y] = at(i, 1);
      return '<line class="radar-spoke" x1="' + cx + '" y1="' + cy + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>';
    })
    .join('');
  const dots = fracs
    .map((f, i) => {
      const [x, y] = at(i, f);
      return '<rect class="radar-dot" x="' + (x - 2.5).toFixed(1) + '" y="' + (y - 2.5).toFixed(1) + '" width="5" height="5"/>';
    })
    .join('');
  const labels = axes
    .map(([, label], i) => {
      const [x, y] = at(i, 1.2);
      const anchor = Math.abs(x - cx) < 4 ? 'middle' : x > cx ? 'start' : 'end';
      return (
        '<text class="radar-label" x="' + x.toFixed(1) + '" y="' + (y - 1).toFixed(1) + '" text-anchor="' + anchor + '">' + label + '</text>' +
        '<text class="radar-value" x="' + x.toFixed(1) + '" y="' + (y + 12).toFixed(1) + '" text-anchor="' + anchor + '">' +
        Math.round(values[i]) + '</text>'
      );
    })
    .join('');

  // The stats added up, tagged into the empty upper-left corner of the box.
  const total = Math.round(statTotal(stats) || 0);
  const power =
    '<g class="radar-power"><rect x="13" y="4" width="' + (44 + String(total).length * 7) + '" height="19"/>' +
    '<text x="18" y="18">PWR ' + total + '</text></g>';

  const accent = TYPE_ORDER.includes(type) ? 'var(--' + type.toLowerCase() + ')' : 'var(--neutral)';
  const summary =
    axes.map(([, label], i) => label + ' ' + Math.round(values[i])).join(', ') + ', PWR ' + total;
  return (
    '<figure class="radar" style="--radar-accent:' + accent + '" role="img" aria-label="' + esc(summary) + '">' +
    '<svg viewBox="13 4 215 183" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    rings + spokes + '<polygon class="radar-shape" points="' + points(fracs) + '"/>' + dots + labels + power +
    '</svg></figure>'
  );
}

/** Stats in whichever form the collection toggle asks for. */
function statsHtml(stats, max, type) {
  return ui.statsMode === 'radar' ? radarHtml(stats, max, type) : statBlockHtml(stats, max);
}

function barChart(entries, { max = 0, colorFn = null, limit = 0, empty = 'Nothing yet.' } = {}) {
  let rows = entries.filter(([, value]) => value > 0);
  if (!rows.length) return '<p class="muted small">' + esc(empty) + '</p>';
  rows.sort((a, b) => b[1] - a[1]);
  if (limit) rows = rows.slice(0, limit);
  const ceiling = max || rows[0][1];
  return (
    '<div class="bars">' +
    rows
      .map(([label, value]) => {
        const width = Math.max(3, Math.round((value / ceiling) * 100));
        const cls = colorFn ? colorFn(label) : 'fill-neutral';
        return (
          '<div class="bar-row"><span class="bar-label">' + esc(label) + '</span>' +
          '<span class="bar-track"><span class="bar-fill ' + cls + '" style="width:' + width + '%"></span></span>' +
          '<span class="bar-value">' + value + '</span></div>'
        );
      })
      .join('') +
    '</div>'
  );
}

function mapToEntries(map) {
  return [...map.entries()];
}

function typeColor(label) {
  return 'fill-' + (TYPE_ORDER.some((t) => t === label) ? label.toLowerCase() : 'neutral');
}

function setBusy(flag, message = '') {
  ui.busy = flag;
  ui.progress = message;
  render();
}

/* -------------------------------------------------------------- add / fetch */

async function doFetch({ forceTitle = null, fresh = false } = {}) {
  const input = (document.getElementById('bey-input')?.value ?? ui.input).trim();
  if (!input && !forceTitle) return;
  ui.error = '';
  ui.choices = null;
  setBusy(true, 'Contacting the wiki...');
  try {
    const result = await fetchBeyblade(input, {
      fresh,
      forceTitle,
      knownParts: store.data.parts,
      productIndex: store.index?.products || null,
      onProgress: (message) => setBusy(true, message),
    });
    if (result.needsChoice) {
      ui.choices = result.options;
      ui.error = result.options.length
        ? 'No exact match. Pick the right page:'
        : 'Nothing from Beyblade X matched that name.';
      if (!store.index?.products?.length) {
        ui.error += ' Press Sync index once to enable partial search across every Beyblade X product.';
      }
    } else {
      ui.pending = {
        input,
        bey: result.bey,
        parts: result.parts,
        qty: 1,
        notes: '',
      };
    }
  } catch (err) {
    ui.error = err.message;
  } finally {
    setBusy(false);
  }
}

function confirmPending(status = 'owned') {
  if (!ui.pending) return;
  const qty = Number(document.getElementById('pending-qty')?.value) || 1;
  const notes = document.getElementById('pending-notes')?.value || '';
  const title = ui.pending.bey?.wikiTitle;
  // Buying something you wished for ticks the wish off instead of duplicating it.
  const wished =
    status === 'owned' && title
      ? store.data.beyblades.find((b) => isWish(b) && b.bey?.wikiTitle === title)
      : null;
  addBeyblade({
    ...ui.pending,
    qty,
    notes: notes || (wished ? wished.notes : ''),
    status,
    id: wished ? wished.id : null,
  });
  ui.pending = null;
  ui.input = '';
  render();
}

/** Re-pull an owned beyblade and every one of its parts, ignoring the cache. */
async function refetchEntry(id) {
  const entry = store.data.beyblades.find((b) => b.id === id);
  if (!entry) return;
  setBusy(true, 'Refreshing ' + entry.displayName + '...');
  try {
    const result = await fetchBeyblade(entry.input || entry.displayName, {
      fresh: true,
      forceTitle: entry.bey?.wikiTitle || null,
      knownParts: {},
      onProgress: (message) => setBusy(true, message),
    });
    if (!result.needsChoice) {
      addBeyblade({
        id: entry.id,
        input: entry.input,
        bey: result.bey,
        parts: result.parts,
        qty: entry.qty,
        notes: entry.notes,
        status: entry.status,
      });
    }
  } catch (err) {
    ui.error = err.message;
  } finally {
    setBusy(false);
  }
}

async function refreshIndex() {
  setBusy(true, 'Rebuilding the part index...');
  try {
    const index = await fetchPartIndex({
      fresh: true,
      onProgress: (message) => setBusy(true, message),
    });
    await saveIndex(index, { onProgress: (message) => setBusy(true, message) });
  } catch (err) {
    ui.error = err.message;
  } finally {
    setBusy(false);
  }
}

/** Pull details for a catalogued part the collection does not own yet. */
async function fetchLoosePart(kind, name, title = '') {
  setBusy(true, 'Fetching ' + PART_LABELS[kind] + ' ' + name + '...');
  try {
    // The catalogue title says which page family it is ("Ratchet-Integrated Bit - Turbo").
    const prefix = title.includes(' - ') ? title.slice(0, title.indexOf(' - ')) : null;
    const part = await fetchPart(kind, name, {}, prefix);
    putPart(kind + ':' + normalizeKey(name), part);
  } catch (err) {
    ui.error = err.message;
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------- saving */

/** Whether every change has reached the server, at a glance. */
function savePill() {
  if (!store.serverAvailable) {
    return '<span class="pill warn" title="Server not reachable - changes stay in this browser">browser only</span>';
  }
  const pending = store.pending.length;
  if (store.saveState.status === 'error') {
    return (
      '<span class="pill warn" title="' + esc(store.saveState.message) + '">not saved' +
      (pending ? ' (' + pending + ')' : '') + '</span>'
    );
  }
  if (store.saveState.status === 'saving' || pending) {
    return '<span class="pill" title="Sending your changes to the server">saving...</span>';
  }
  return '<span class="pill ok" title="Every change has reached the server">saved</span>';
}

function saveNotices() {
  let html = '';
  if (store.saveState.status === 'error') {
    const stale = store.saveState.code === 'stale-client';
    html +=
      '<div class="notice error save-error"><span>' + esc(store.saveState.message) +
      (stale ? '' : ' Your changes are kept in this browser until the server accepts them.') +
      '</span>' +
      (stale
        ? '<button class="ghost small" data-action="reload-page">Reload page</button>'
        : '<button class="ghost small" data-action="retry-save">Retry</button>') +
      '</div>';
  }
  if (store.recovery && store.viewing.isSelf) {
    const names = store.recovery.entries.map((entry) => entry.displayName);
    html +=
      '<div class="notice stale recovery"><span>' +
      names.length + (names.length === 1 ? ' beyblade' : ' beyblades') +
      ' added earlier in this browser never reached the server: <strong>' + esc(names.join(', ')) +
      '</strong>. Restore them?</span><span class="stale-actions">' +
      '<button class="ghost small" data-action="recover-restore">Restore</button>' +
      '<button class="link" data-action="recover-discard">Discard</button></span></div>';
  }
  return html;
}

/* Save progress changes often; redraw just the pill and banners, not the page. */
function updateSaveIndicators() {
  if (!auth.user) return;
  const pill = document.getElementById('save-pill-slot');
  if (pill) pill.innerHTML = savePill();
  const slot = document.getElementById('save-slot');
  if (slot) slot.innerHTML = saveNotices();
}

/* ---------------------------------------------------------------- catalogue */

const CATALOGUE_MAX_AGE_DAYS = 5;

/** When the catalogue was last downloaded. Older files only carry the save stamp. */
function catalogueUpdatedAt() {
  const index = store.index || {};
  return index.catalogueUpdatedAt || index.updatedAt || null;
}

function catalogueState() {
  const stamp = catalogueUpdatedAt();
  if (!stamp) return { stale: true, reason: 'never' };
  // Catalogues from before partial search, Hasbro names or Expand Blade parts need one refresh.
  const products = store.index?.products || [];
  const total = store.index?.productsTotal;
  if (
    !products.length ||
    typeof products[0] === 'string' ||
    !store.index?.categories?.overBlade ||
    (typeof total === 'number' && products.length !== total)
  ) {
    return { stale: true, reason: 'legacy' };
  }
  const days = Math.floor((Date.now() - new Date(stamp).getTime()) / 86400000);
  return { stale: days > CATALOGUE_MAX_AGE_DAYS, reason: 'age', days };
}

/** Offer the refresh; never run it unasked, so wiki traffic stays button-driven. */
function cataloguePrompt() {
  if (ui.busy || ui.cataloguePromptLater || !store.serverAvailable) return '';
  const state = catalogueState();
  if (!state.stale) return '';
  const text =
    state.reason === 'never'
      ? 'The Beyblade X catalogue has never been downloaded.'
      : state.reason === 'legacy'
        ? 'The catalogue comes from an older version of the app and needs one refresh.'
        : 'The catalogue was last updated ' + state.days + ' days ago.';
  return (
    '<div class="notice stale">' +
    '<span>' + esc(text) + ' Update it now? <span class="stale-cost">about 25 wiki requests</span></span>' +
    '<span class="stale-actions">' +
    '<button class="ghost small" data-action="refresh-index">Update now</button>' +
    '<button class="link" data-action="catalogue-later">Later</button>' +
    '</span></div>'
  );
}

/* ------------------------------------------------------------------- views */

function header() {
  const status = '<span id="save-pill-slot">' + savePill() + '</span>';
  const stamp = catalogueUpdatedAt();
  const indexed = stamp
    ? 'catalogue ' + new Date(stamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    : 'no catalogue';
  const staleClass = catalogueState().stale ? ' warn' : '';

  const account = auth.user
    ? '<span class="pill user-pill">' + esc(auth.user.username) + (auth.user.owner ? ' &#9733;' : '') + '</span>' +
      (auth.user.owner
        ? '<button class="ghost" data-action="toggle-registration" title="Allow other people to create accounts">' +
          'Signup ' + (auth.registrationOpen ? 'on' : 'off') + '</button>'
        : '') +
      '<button class="ghost" data-action="logout">Log out</button>'
    : '';

  return (
    '<header class="topbar">' +
    '<div class="brand"><h1>OMGBBManager</h1>' +
    '<p class="muted small">Beyblade X collection &middot; Hasbro releases</p></div>' +
    '<nav class="tabs">' +
    ['collection', 'combos', 'parts', 'analysis', 'bladers']
      .map(
        (view) =>
          '<button class="tab' + (ui.view === view ? ' active' : '') + '" data-action="view" data-view="' + view + '">' +
          view[0].toUpperCase() + view.slice(1) + '</button>'
      )
      .join('') +
    '</nav>' +
    '<div class="topbar-tools">' + status +
    '<span class="pill' + staleClass + '">' + esc(indexed) + '</span>' +
    (store.viewing.isSelf
      ? '<button class="ghost" data-action="refresh-index" title="Fetch the part catalogue and the Beyblade X product list from the wiki (about 25 requests)">Sync index</button>'
      : '') +
    '<button class="ghost" data-action="export">Export</button>' +
    (store.viewing.isSelf ? '<button class="ghost" data-action="import">Import</button>' : '') +
    account +
    '</div></header>'
  );
}

function busyBar() {
  if (!ui.busy && !ui.error) return '';
  if (ui.busy) {
    return '<div class="notice busy"><span class="spinner"></span>' + esc(ui.progress || 'Working...') + '</div>';
  }
  return '<div class="notice error">' + esc(ui.error) +
    (ui.choices
      ? '<div class="choices">' +
        ui.choices
          .map((choice) => {
            // Shown under the Hasbro name; the wiki name rides along for cross-reference.
            const item = typeof choice === 'string' ? { title: choice } : choice;
            const note =
              item.hasbro && item.hasbro !== item.title
                ? '(' + item.title + ')'
                : item.hasbroReleased === false
                  ? '(Takara Tomy only)'
                  : '';
            return (
              '<button class="chip" data-action="choose" data-title="' + esc(item.title) + '">' +
              esc(item.hasbro || item.title) +
              (note ? ' <small class="tt-name">' + esc(note) + '</small>' : '') +
              '</button>'
            );
          })
          .join('') +
        '</div>'
      : '') +
    '<button class="link" data-action="dismiss-error">dismiss</button></div>';
}

function addPanel() {
  const pending = ui.pending;
  let html =
    '<section class="panel add-panel">' +
    '<div class="add-row">' +
    '<input id="bey-input" type="text" placeholder="e.g. Reaper Rhino C4-55D  or  Dran Sword 3-60F" ' +
    'value="' + esc(ui.input) + '" autocomplete="off" spellcheck="false">' +
    '<button class="primary" data-action="fetch"' + (ui.busy ? ' disabled' : '') + '>Fetch from wiki</button>' +
    '</div>' +
    '<p class="muted small">Nothing is fetched until you press the button. Pages are cached on disk, so ' +
    'the same beyblade is only ever downloaded once.</p>';

  if (pending) {
    const stats = sumPartStats(pending.parts);
    const same = store.data.beyblades.filter(
      (b) => b.bey?.wikiTitle && b.bey.wikiTitle === pending.bey.wikiTitle
    );
    const ownedCopy = same.find((b) => !isWish(b));
    const hint = ownedCopy
      ? 'Already in your collection (x' + ownedCopy.qty + ').'
      : same.length
        ? 'Already on your wishlist - adding it to the collection ticks it off.'
        : '';
    html +=
      '<div class="preview">' +
      '<div class="preview-main">' +
      (pending.bey.image ? '<img class="thumb" src="' + esc(pending.bey.image) + '" alt="">' : '') +
      '<div>' +
      '<h3>' + esc(pending.bey.hasbroName || pending.bey.wikiName) + '</h3>' +
      '<p class="muted small">' + esc(pending.bey.wikiTitle) +
      (pending.bey.hasbroName ? ' <span class="sep">/</span> Hasbro name' : '') + '</p>' +
      '<p class="meta">' + badge(pending.bey.type) +
      '<span class="pill">' + esc(pending.bey.system || 'Unknown line') + '</span>' +
      (pending.bey.productCodes?.hasbro
        ? '<span class="pill">' + esc(pending.bey.productCodes.hasbro) + '</span>'
        : '<span class="pill warn">no Hasbro release</span>') +
      (comboWeight(pending.parts, pending.bey)
        ? '<span class="pill">' + comboWeight(pending.parts, pending.bey).grams.toFixed(1) + ' g</span>'
        : '') +
      '</p>' +
      '<p class="parts-line">' + partSummary(pending.parts) + '</p>' +
      '</div></div>' +
      '<div class="preview-side">' + statsHtml(stats, statCeiling([stats]), pending.bey.type) + '</div>' +
      '<div class="preview-actions">' +
      '<label>Qty <input id="pending-qty" type="number" min="1" value="' + pending.qty + '" class="qty"></label>' +
      '<input id="pending-notes" type="text" placeholder="notes (optional)" value="' + esc(pending.notes) + '">' +
      // A look at the full wiki page before committing; opens in a new tab.
      '<a class="ghost wiki-check" href="' + esc(pending.bey.wikiUrl || '#') + '" target="_blank" rel="noopener" ' +
      'title="Open the wiki page in a new tab">Check on wiki</a>' +
      '<button class="primary" data-action="confirm" data-status="owned">Add to collection</button>' +
      '<button class="ghost wish-btn" data-action="confirm" data-status="wish">Add to wishlist</button>' +
      '<button class="ghost" data-action="cancel-pending">Cancel</button>' +
      (hint ? '<p class="preview-note">' + esc(hint) + '</p>' : '') +
      '</div></div>';
  }
  return html + '</section>';
}

/**
 * Weight of the combination: the wiki's product weight when it has one, since
 * the stored parts can miss pieces (an integrated ratchet-bit such as "Tr" is
 * not listed separately); otherwise the sum of the parts - but only when the
 * parts include a blade and a bit, so a half-read combination never passes for
 * the whole thing.
 */
function comboWeight(parts, bey) {
  if (typeof bey?.weight === 'number') return { grams: bey.weight, source: 'product' };
  const list = Object.values(parts || {});
  const hasBlade = ['blade', 'mainBlade', 'metalBlade'].some((kind) => parts && parts[kind]);
  const hasBottom = Boolean(parts && (parts.bit || parts.ratchet));
  if (hasBlade && hasBottom && list.every((part) => typeof part.weight === 'number')) {
    const grams = Math.round(list.reduce((sum, part) => sum + part.weight, 0) * 10) / 10;
    return { grams, source: 'parts' };
  }
  return null;
}

function weightLine(parts, bey) {
  const weight = comboWeight(parts, bey);
  if (!weight) return '';
  const line = bey?.system ? String(bey.system).replace(/\n/g, ' ') : '';
  return (
    '<p class="card-weight"><span class="card-weight-label">Weight</span>' +
    '<strong>' + weight.grams.toFixed(1) + ' g</strong>' +
    '<span class="card-weight-note">' +
    (weight.source === 'parts' ? 'sum of parts' : 'product weight') +
    (line ? ' &middot; ' + esc(line) : '') +
    '</span></p>'
  );
}

function sumPartStats(parts) {
  const totals = { attack: 0, defense: 0, stamina: 0, dash: 0, burst: 0 };
  let any = false;
  for (const part of Object.values(parts || {})) {
    for (const key of Object.keys(totals)) {
      if (typeof part.stats?.[key] === 'number') {
        totals[key] += part.stats[key];
        any = true;
      }
    }
  }
  return any ? totals : null;
}

function statCeiling(list) {
  let max = 1;
  for (const stats of list) {
    if (!stats) continue;
    // Dash and burst share the scale: they are often the largest numbers on a bit.
    max = Math.max(
      max,
      stats.attack || 0,
      stats.defense || 0,
      stats.stamina || 0,
      stats.dash || 0,
      stats.burst || 0
    );
  }
  return max;
}

function collectionView() {
  const entries = filteredEntries();
  const ownedTotal = store.data.beyblades.filter((entry) => !isWish(entry)).length;
  const wishTotal = store.data.beyblades.length - ownedTotal;
  const ownedShown = entries.filter((entry) => !isWish(entry)).length;
  const ceiling = statCeiling(store.data.beyblades.map((e) => combinedStats(e)));

  let html = store.viewing.isSelf ? addPanel() : '';
  html +=
    '<section class="toolbar">' +
    '<input id="search" type="search" placeholder="Filter by name, part, code..." value="' + esc(ui.search) + '">' +
    '<select id="shelf-filter" title="Show owned beyblades, wished-for ones, or both">' +
    [
      ['all', 'Owned + wishlist'],
      ['owned', 'Owned only'],
      ['wish', 'Wishlist only'],
    ]
      .map(
        ([value, label]) =>
          '<option value="' + value + '"' + (ui.shelfFilter === value ? ' selected' : '') + '>' + label + '</option>'
      )
      .join('') +
    '</select>' +
    '<select id="type-filter">' +
    ['all', ...TYPE_ORDER]
      .map(
        (t) =>
          '<option value="' + t + '"' + (ui.typeFilter === t ? ' selected' : '') + '>' +
          (t === 'all' ? 'All types' : t) + '</option>'
      )
      .join('') +
    '</select>' +
    '<select id="sort">' +
    [
      ['added-desc', 'Newest first'],
      ['added-asc', 'Oldest first'],
      ['name-asc', 'Name A-Z'],
      ['weight-desc', 'Heaviest'],
      ['attack-desc', 'Most attack'],
      ['defense-desc', 'Most defense'],
      ['stamina-desc', 'Most stamina'],
    ]
      .map(
        ([value, label]) =>
          '<option value="' + value + '"' + (ui.sort === value ? ' selected' : '') + '>' + label + '</option>'
      )
      .join('') +
    '</select>' +
    '<button class="switch' + (ui.statsMode === 'radar' ? ' on' : '') + '" data-action="stats-mode" role="switch" ' +
    'aria-checked="' + (ui.statsMode === 'radar') + '" title="Show stats as a radar chart instead of bars">' +
    '<span class="switch-label">Radar</span><span class="switch-track"><span class="switch-knob"></span></span>' +
    '</button>' +
    '<span class="muted small">' + ownedShown + '/' + ownedTotal + ' owned &middot; ' +
    (entries.length - ownedShown) + '/' + wishTotal + ' wished</span>' +
    '</section>';

  if (!store.data.beyblades.length) {
    html += store.viewing.isSelf
      ? '<div class="empty"><h2>No beyblades yet</h2>' +
        '<p class="muted">Type a product name above and press <strong>Fetch from wiki</strong>. ' +
        'Hasbro spellings work: <em>Reaper Rhino C4-55D</em>, <em>Dran Sword 3-60F</em>.</p></div>'
      : '<div class="empty"><h2>Empty shelf</h2><p class="muted">' +
        esc(store.viewing.username) + ' has not added anything yet.</p></div>';
    return html;
  }

  if (!entries.length) {
    return html + '<p class="shelf-note">Nothing matches these filters.</p>';
  }

  // One grid for owned and wished alike, so sorting orders them together; the
  // wish cards carry their own paper.
  html +=
    '<div class="grid">' +
    entries.map((entry, i) => beyCard(entry, ceiling, i + 1)).join('') +
    '</div>';
  return html;
}

function beyCard(entry, ceiling, serial) {
  const parts = partsOf(entry);
  const bey = entry.bey || {};
  const stats = combinedStats(entry);
  const cx = Boolean(parts.lockChip);
  const wish = isWish(entry);
  const mine = store.viewing.isSelf;
  const id = entry.id;
  // Radar mode puts the picture beside the chart instead of beside the title.
  const radar = ui.statsMode === 'radar';
  const picture = bey.image
    ? '<img class="thumb" src="' + esc(bey.image) + '" alt="" loading="lazy">'
    : '<div class="thumb ph"></div>';

  let actions = '<button class="ghost small" data-action="detail" data-id="' + id + '">Details</button>';
  if (wish && mine) {
    actions +=
      '<button class="ghost small got-it" data-action="acquire" data-id="' + id + '" ' +
      'title="Move it into the collection">Got it</button>' +
      '<button class="ghost small" data-action="refetch" data-id="' + id + '">Re-fetch</button>';
  } else if (!wish && mine) {
    actions +=
      '<button class="ghost small" data-action="qty-dec" data-id="' + id + '">-</button>' +
      '<span class="qty-label">' + entry.qty + '</span>' +
      '<button class="ghost small" data-action="qty-inc" data-id="' + id + '">+</button>' +
      '<button class="ghost small wish-btn" data-action="wish-it" data-id="' + id + '" ' +
      'title="Move it back to the wishlist">Wish it</button>' +
      '<button class="ghost small" data-action="refetch" data-id="' + id + '">Re-fetch</button>';
  } else if (!wish) {
    actions += '<span class="qty-label">x' + entry.qty + '</span>';
  }
  actions += '<a class="ghost small" href="' + esc(bey.wikiUrl || '#') + '" target="_blank" rel="noopener">Wiki</a>';
  if (mine) {
    actions += '<button class="ghost small danger" data-action="remove" data-id="' + id + '">Remove</button>';
  }

  const tag = wish
    ? 'Wish.' + String(serial).padStart(2, '0')
    : 'No.' + String(serial).padStart(3, '0');

  return (
    '<article class="card' + (wish ? ' wish' : '') + '" data-id="' + id + '" data-type="' + esc(bey.type || '') + '">' +
    '<span class="card-serial">' + tag + '</span>' +
    '<div class="card-head">' +
    (radar ? '' : picture) +
    '<div class="card-title">' +
    '<h3>' + esc(entry.displayName) + '</h3>' +
    '<p class="meta">' + badge(bey.type) +
    (cx ? '<span class="pill cx">CX</span>' : '') +
    (bey.productCodes?.hasbro ? '<span class="pill">' + esc(bey.productCodes.hasbro) + '</span>' : '') +
    (entry.qty > 1 ? '<span class="pill qty-pill">x' + entry.qty + '</span>' : '') +
    (bey.series && !String(bey.series).startsWith('Beyblade X')
      ? '<span class="pill warn" title="' + esc(bey.series) + '">not Beyblade X</span>'
      : '') +
    '</p></div></div>' +

    '<dl class="part-list">' +
    PART_KINDS.filter((k) => parts[k])
      .map(
        (kind) =>
          '<div><dt>' + esc(PART_LABELS[kind]) + '</dt>' +
          '<dd title="' + esc(parts[kind].name) + '">' + esc(partName(parts[kind])) +
          codeChip(parts[kind]) + integratedNote(parts[kind]) +
          (parts[kind].type ? ' ' + badge(parts[kind].type) : '') +
          '</dd></div>'
      )
      .join('') +
    '</dl>' +

    (radar
      ? '<div class="card-media">' + picture + radarHtml(stats, ceiling, bey.type) + '</div>'
      : statBlockHtml(stats, ceiling)) +
    weightLine(parts, bey) +
    (mine &&
    (!['blade', 'mainBlade', 'overBlade', 'metalBlade'].some((kind) => parts[kind]) || (!parts.ratchet && !parts.bit))
      ? '<p class="card-hint">Parts incomplete: press Re-fetch to load them from the wiki.</p>'
      : '') +
    (entry.notes ? '<p class="notes">' + esc(entry.notes) + '</p>' : '') +

    '<div class="card-actions">' + actions + '</div></article>'
  );
}

function filteredEntries() {
  const term = ui.search.trim().toLowerCase();
  let entries = store.data.beyblades.filter((entry) => {
    if (ui.shelfFilter === 'owned' && isWish(entry)) return false;
    if (ui.shelfFilter === 'wish' && !isWish(entry)) return false;
    if (ui.typeFilter !== 'all' && (entry.bey?.type || '') !== ui.typeFilter) return false;
    if (!term) return true;
    const parts = Object.values(partsOf(entry)).map((p) => p.name + ' ' + (p.code || ''));
    const haystack = [
      entry.displayName,
      entry.input,
      entry.notes,
      entry.bey?.wikiTitle,
      entry.bey?.productCodes?.hasbro,
      ...parts,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(term);
  });

  const stat = (entry, key) => combinedStats(entry)?.[key] ?? -1;
  const weightOf = (entry) => comboWeight(partsOf(entry), entry.bey)?.grams || 0;
  const sorters = {
    'added-desc': (a, b) => String(b.addedAt).localeCompare(String(a.addedAt)),
    'added-asc': (a, b) => String(a.addedAt).localeCompare(String(b.addedAt)),
    'name-asc': (a, b) => a.displayName.localeCompare(b.displayName),
    'weight-desc': (a, b) => weightOf(b) - weightOf(a),
    'attack-desc': (a, b) => stat(b, 'attack') - stat(a, 'attack'),
    'defense-desc': (a, b) => stat(b, 'defense') - stat(a, 'defense'),
    'stamina-desc': (a, b) => stat(b, 'stamina') - stat(a, 'stamina'),
  };
  entries = [...entries].sort(sorters[ui.sort] || sorters['added-desc']);
  return entries;
}

/* ------------------------------------------------------------- parts view */

/**
 * Catalogue entries for one part kind, deduplicated by name. Some parts have
 * both a Hasbro and a Takara Tomy page; the Hasbro one wins.
 */
function catalogueFor(kind) {
  const listed = store.index?.categories?.[kind] || [];
  const byName = new Map();
  for (const entry of listed) {
    const key = normalizeKey(entry.name);
    const current = byName.get(key);
    if (!current || (current.variant === 'Takara Tomy' && entry.variant !== 'Takara Tomy')) {
      byName.set(key, entry);
    }
  }
  return [...byName.values()].sort((a, b) => (a.hasbro || a.name).localeCompare(b.hasbro || b.name));
}

function partsView() {
  const grouped = inventoryByKind();

  let html =
    '<section class="toolbar">' +
    '<div class="kind-tabs">' +
    PART_KINDS.map((kind) => {
      const records = grouped[kind] || [];
      const owned = records.filter((r) => r.count > 0).length;
      const wishOnly = records.length - owned;
      const known = catalogueFor(kind).length;
      return (
        '<button class="tab small' + (ui.partKind === kind ? ' active' : '') + '" data-action="kind" data-kind="' + kind + '">' +
        esc(PART_LABELS[kind]) + 's <span class="count">' + owned + (known ? '/' + known : '') + '</span>' +
        (wishOnly ? '<span class="count wish-count">+' + wishOnly + '</span>' : '') +
        '</button>'
      );
    }).join('') +
    '</div>' +
    '<span class="legend"><i class="swatch owned"></i>Owned<i class="swatch wish"></i>Wishlist</span>' +
    '<label class="toggle"><input type="checkbox" id="show-unowned"' + (ui.showUnowned ? ' checked' : '') +
    '> show parts I do not own</label>' +
    '</section>';

  const kind = ui.partKind;
  const rows = grouped[kind] || [];

  if (!rows.length && !ui.showUnowned) {
    html += '<div class="empty"><h2>No ' + esc(PART_LABELS[kind].toLowerCase()) + 's yet</h2>' +
      '<p class="muted">Parts appear here automatically once you add a beyblade that contains them.</p></div>';
    return html;
  }

  const ceiling = Math.max(
    1,
    ...rows.map((r) => Math.max(r.part.stats?.attack || 0, r.part.stats?.defense || 0, r.part.stats?.stamina || 0))
  );

  html +=
    '<div class="table-wrap"><table class="parts-table"><thead><tr>' +
    '<th class="thumb-col"></th>' +
    '<th>' + esc(PART_LABELS[kind]) + '</th><th>Type</th><th class="num">Owned</th>' +
    '<th>Stats</th><th class="num">Weight</th><th>From</th><th></th>' +
    '</tr></thead><tbody>' +
    rows.map((record) => partRow(record, ceiling)).join('');

  if (ui.showUnowned) {
    const ownedKeys = new Set(rows.map((r) => normalizeKey(r.part.name)));
    const missing = catalogueFor(kind).filter((p) => !ownedKeys.has(normalizeKey(p.name)));
    html += missing
      .map((p) => {
        const cachedKey = kind + ':' + normalizeKey(p.name);
        const cached = store.data.parts[cachedKey];
        return (
          '<tr class="unowned">' +
          '<td class="thumb-col">' + partThumb(cached) + '</td>' +
          '<td>' + esc(p.hasbro || cached?.hasbroName || p.name) +
          (cached?.code ? ' <span class="code">' + esc(cached.code) + '</span>' : '') +
          ((p.hasbro || cached?.hasbroName || p.name) !== p.name
            ? ' <span class="muted small">' + esc(p.name) + '</span>'
            : '') +
          '</td>' +
          '<td>' + (cached?.type ? badge(cached.type) : '<span class="muted small">-</span>') + '</td>' +
          '<td class="num">0</td>' +
          '<td>' + (cached ? miniStats(cached.stats, ceiling) : '<span class="muted small">not fetched</span>') + '</td>' +
          '<td class="num">' + (cached?.weight ? cached.weight + ' g' : '-') + '</td>' +
          '<td class="muted small">wiki catalogue</td>' +
          '<td class="row-actions">' +
          (cached || !store.viewing.isSelf
            ? ''
            : '<button class="ghost small" data-action="fetch-part" data-kind="' + kind + '" data-name="' + esc(p.name) + '" data-title="' + esc(p.title) + '">Fetch</button>') +
          '<a class="ghost small" href="' + esc(wikiUrl(p.title)) + '" target="_blank" rel="noopener">Wiki</a>' +
          '</td></tr>'
        );
      })
      .join('');
    if (!missing.length && !catalogueFor(kind).length) {
      html += '<tr><td colspan="8" class="muted small">Press <strong>Sync index</strong> to download the ' +
        'full catalogue of parts from the wiki.</td></tr>';
    }
  }

  return html + '</tbody></table></div>';
}

function miniStats(stats, ceiling) {
  if (!stats || (!stats.attack && !stats.defense && !stats.stamina)) {
    return '<span class="muted small">-</span>';
  }
  const cell = (value, cls) => {
    const width = Math.max(3, Math.round(((value || 0) / ceiling) * 100));
    return '<span class="mini"><span class="mini-fill ' + cls + '" style="width:' + width + '%"></span></span>';
  };
  return (
    '<div class="mini-stats" title="ATK ' + (stats.attack ?? '-') + ' / DEF ' + (stats.defense ?? '-') +
    ' / STA ' + (stats.stamina ?? '-') + '">' +
    cell(stats.attack, 'fill-attack') + cell(stats.defense, 'fill-defense') + cell(stats.stamina, 'fill-stamina') +
    '</div>'
  );
}

function partRow(record, ceiling) {
  const part = record.part;
  const wishOnly = record.count === 0;
  const owners = record.sources
    .filter((s) => s.status !== 'wish')
    .map((s) => esc(s.name));
  const wishers = record.sources
    .filter((s) => s.status === 'wish')
    .map((s) => '<span class="wish-src">' + esc(s.name) + '</span>');
  return (
    '<tr' + (wishOnly ? ' class="wish-row"' : '') + '>' +
    '<td class="thumb-col">' + partThumb(part) + '</td>' +
    '<td><strong>' + esc(partName(part)) + '</strong>' + codeChip(part) + integratedNote(part) +
    (partAltName(part) ? ' <span class="muted small">' + esc(partAltName(part)) + '</span>' : '') +
    (part.hasbroReleased === false ? ' <span class="pill warn tiny">import</span>' : '') +
    '</td>' +
    '<td>' + (part.type ? badge(part.type) : '<span class="muted small">-</span>') + '</td>' +
    '<td class="num">' + record.count +
    (record.wishCount ? ' <span class="wish-chip">+' + record.wishCount + ' wish</span>' : '') +
    '</td>' +
    '<td>' + miniStats(part.stats, ceiling) + '</td>' +
    '<td class="num">' + (part.weight ? part.weight + ' g' : '-') + '</td>' +
    '<td class="muted small">' + owners.concat(wishers).join(', ') + '</td>' +
    '<td class="row-actions">' +
    '<a class="ghost small" href="' + esc(part.wikiUrl || '#') + '" target="_blank" rel="noopener">Wiki</a>' +
    '</td></tr>'
  );
}

/* ------------------------------------------------------------ combos view */

/*
 * Combinations the blader builds out of parts already on the shelf. The blade
 * chosen first decides the line, and the line decides which slots follow it -
 * a Custom Line main blade asks for a lock chip and an assist blade, a blade
 * with the ratchet built in never asks for a ratchet.
 */

/* putCombo / removeCombo arrived in this backend version. */
const COMBO_API = 3;

function newBuilder(combo = null) {
  if (!combo) {
    return {
      id: null,
      lead: 'blade',
      partKeys: {},
      nickname: '',
      tags: [],
      rating: 0,
      strengths: '',
      weaknesses: '',
      includeUnowned: false,
    };
  }
  return {
    id: combo.id,
    lead: combo.lead || leadKindOf(combo.partKeys),
    partKeys: { ...combo.partKeys },
    nickname: combo.nickname || '',
    tags: [...(combo.tags || [])],
    rating: combo.rating || 0,
    strengths: combo.strengths || '',
    weaknesses: combo.weaknesses || '',
    includeUnowned: false,
  };
}

function leadKindOf(partKeys = {}) {
  return COMBO_LEAD_KINDS.find((kind) => partKeys[kind]) || 'blade';
}

/**
 * The parts on offer for one slot: what the shelf physically holds, plus - when
 * asked - everything else it knows about (wished for, or fetched loose from the
 * catalogue). Whatever is already chosen stays on the list either way.
 */
function partChoices(kind, inventory, selectedKey = '') {
  const out = new Map();
  for (const record of inventory.values()) {
    if (record.kind === kind && record.count > 0) {
      out.set(record.key, { key: record.key, part: record.part, owned: true });
    }
  }
  if (ui.builder?.includeUnowned) {
    for (const [key, part] of Object.entries(store.data.parts)) {
      if (part && part.kind === kind && !out.has(key)) out.set(key, { key, part, owned: false });
    }
  }
  if (selectedKey && !out.has(selectedKey) && store.data.parts[selectedKey]) {
    out.set(selectedKey, { key: selectedKey, part: store.data.parts[selectedKey], owned: false });
  }
  const choices = [...out.values()];
  choices.sort((a, b) => {
    if (kind === 'ratchet') {
      const sa = ratchetShape(a.part.name);
      const sb = ratchetShape(b.part.name);
      if (sa.height && sb.height && sa.height !== sb.height) return sa.height - sb.height;
    }
    return partName(a.part).localeCompare(partName(b.part));
  });
  return choices;
}

function choiceLabel(choice) {
  const part = choice.part;
  const alt = partAltName(part);
  return (
    partName(part) +
    (part.code ? ' (' + part.code + ')' : '') +
    (alt ? ' - ' + alt : '') +
    (integratedExtra(part) ? ' [+' + integratedExtra(part) + ']' : '') +
    (choice.owned ? '' : ' - not owned')
  );
}

function slotSelect(kind, choices, selectedKey, label) {
  const what = (label || PART_LABELS[kind]).toLowerCase();
  return (
    '<label class="slot"><span class="slot-label">' + esc(label || PART_LABELS[kind]) + '</span>' +
    '<select data-slot="' + kind + '">' +
    '<option value="">-- pick a' + (/^[aeiou]/.test(what) ? 'n ' : ' ') + esc(what) + ' --</option>' +
    choices
      .map(
        (choice) =>
          '<option value="' + esc(choice.key) + '"' + (choice.key === selectedKey ? ' selected' : '') + '>' +
          esc(choiceLabel(choice)) + '</option>'
      )
      .join('') +
    '</select></label>'
  );
}

/** The first select spans all three blade families; picking one sets the line. */
function leadSelect(inventory, builder) {
  const selected = builder.partKeys[builder.lead] || '';
  const groups = COMBO_LEAD_KINDS.map((kind) => {
    const choices = partChoices(kind, inventory, builder.lead === kind ? selected : '');
    if (!choices.length) return '';
    return (
      '<optgroup label="' + esc(PART_LABELS[kind] + 's - ' + COMBO_LINES[kind].line) + '">' +
      choices
        .map(
          (choice) =>
            '<option value="' + kind + '|' + esc(choice.key) + '"' +
            (builder.lead === kind && choice.key === selected ? ' selected' : '') + '>' +
            esc(choiceLabel(choice)) + '</option>'
        )
        .join('') +
      '</optgroup>'
    );
  }).join('');

  return (
    '<label class="slot slot-lead"><span class="slot-label">Blade</span>' +
    '<select data-slot="lead">' +
    '<option value="">-- pick a blade --</option>' + groups +
    '</select></label>'
  );
}

/**
 * Stars. Interactive ones carry an action; the rest are just a reading.
 *
 * The buttons are written highest-first and laid out right-to-left, so plain
 * CSS can light up the star under the cursor and every one before it
 * (`.star:hover ~ .star` reaches the ones printed after it - to its left).
 */
function starRow(rating, { action = '', id = '' } = {}) {
  const stars = [5, 4, 3, 2, 1]
    .map((n) => {
      const on = n <= rating ? ' on' : '';
      if (!action) return '<span class="star' + on + '">&#9733;</span>';
      return (
        '<button class="star' + on + '" data-action="' + action + '" data-id="' + esc(id) + '" ' +
        'data-value="' + n + '" title="' + n + ' out of 5" aria-label="' + n + ' out of 5">&#9733;</button>'
      );
    })
    .join('');
  return '<span class="stars' + (action ? ' live' : '') + '">' + stars + '</span>';
}

/** A combo's own tags. Clicking one filters the view by it. */
function tagChips(tags) {
  if (!tags?.length) return '';
  return (
    '<p class="tag-row">' +
    tags
      .map(
        (tag) =>
          '<button class="tag' + (ui.comboFilter.includes(tag) ? ' on' : '') + '" ' +
          'data-action="combo-filter" data-tag="' + esc(tag) + '" ' +
          'title="Show only combinations tagged ' + esc(tag) + '">' + esc(tag) + '</button>'
      )
      .join('') +
    '</p>'
  );
}

function comboBuilder() {
  const builder = ui.builder;
  const inventory = partInventory();
  const parts = partsOf(builder);
  const slots = comboSlots(builder.lead, parts);
  const line = COMBO_LINES[builder.lead].line;
  const missing = slots.filter((kind) => !builder.partKeys[kind]);
  const used = comboTags();
  const name = comboName(parts);
  const stats = sumPartStats(parts);
  const weight = comboWeight(parts, null);

  const others = slots
    .filter((kind) => kind !== builder.lead)
    .map((kind) =>
      slotSelect(kind, partChoices(kind, inventory, builder.partKeys[kind] || ''), builder.partKeys[kind] || '')
    )
    .join('');

  return (
    '<section class="panel add-panel combo-builder">' +
    '<div class="builder-head">' +
    '<h2>' + (builder.id ? 'Edit combination' : 'New combination') + '</h2>' +
    '<span class="pill">' + esc(line) + '</span>' +
    (integratedExtra(parts[builder.lead]) === 'ratchet'
      ? '<span class="pill">ratchet built in</span>'
      : '') +
    (integratedExtra(parts.ratchet) === 'bit' ? '<span class="pill">bit built in</span>' : '') +
    '</div>' +

    '<div class="slots">' + leadSelect(inventory, builder) + others + '</div>' +

    '<label class="toggle"><input type="checkbox" id="combo-unowned"' +
    (builder.includeUnowned ? ' checked' : '') + '> also offer parts I do not own yet</label>' +

    '<div class="builder-name">' +
    '<span class="builder-name-label">Name</span>' +
    '<strong>' + (name ? esc(name) : '<span class="muted">pick a blade to start</span>') + '</strong>' +
    (weight ? '<span class="pill">' + weight.grams.toFixed(1) + ' g</span>' : '') +
    '</div>' +

    '<div class="builder-grid">' +
    '<div class="builder-fields">' +
    '<label class="field"><span>Nickname (optional)</span>' +
    '<input id="combo-nickname" type="text" maxlength="60" placeholder="e.g. The Lawnmower" value="' +
    esc(builder.nickname) + '"></label>' +

    '<label class="field"><span>Tags (comma separated)</span>' +
    '<input id="combo-tagline" type="text" placeholder="meta, test, funsies" value="' +
    esc(builder.tags.join(', ')) + '"></label>' +
    // Only tags this shelf already uses: the quick row is for reusing them,
    // new ones are typed above.
    (used.length
      ? '<p class="tag-suggest">' +
        used
          .map(
            ([tag]) =>
              '<button class="chip' + (builder.tags.includes(tag) ? ' on' : '') + '" ' +
              'data-action="combo-tag-quick" data-tag="' + esc(tag) + '">' + esc(tag) + '</button>'
          )
          .join('') +
        '</p>'
      : '') +

    '<label class="field"><span>Rating</span>' + starRow(builder.rating, { action: 'combo-rate-draft' }) + '</label>' +

    '<label class="field"><span>Strengths</span>' +
    '<textarea id="combo-strengths" rows="3" placeholder="what it does well in a battle">' +
    esc(builder.strengths) + '</textarea></label>' +

    '<label class="field"><span>Weaknesses</span>' +
    '<textarea id="combo-weaknesses" rows="3" placeholder="what beats it">' +
    esc(builder.weaknesses) + '</textarea></label>' +
    '</div>' +

    '<div class="builder-side">' +
    (stats ? statsHtml(stats, statCeiling([stats]), parts[builder.lead]?.type) : '') +
    '<dl class="part-list">' +
    slots
      .map(
        (kind) =>
          '<div><dt>' + esc(PART_LABELS[kind]) + '</dt><dd>' +
          (parts[kind]
            ? esc(partName(parts[kind])) + codeChip(parts[kind]) + integratedNote(parts[kind])
            : '<span class="muted">-</span>') +
          '</dd></div>'
      )
      .join('') +
    '</dl>' +
    '</div></div>' +

    '<div class="builder-actions">' +
    '<button class="primary" data-action="combo-save"' + (missing.length ? ' disabled' : '') + '>' +
    (builder.id ? 'Save changes' : 'Save combination') + '</button>' +
    '<button class="ghost" data-action="combo-cancel">Cancel</button>' +
    (missing.length
      ? '<span class="muted small">still to pick: ' +
        esc(missing.map((kind) => PART_LABELS[kind].toLowerCase()).join(', ')) + '</span>'
      : '') +
    '</div></section>'
  );
}

function comboCard(combo, ceiling, serial) {
  const parts = partsOf(combo);
  const mine = store.viewing.isSelf;
  const stats = sumPartStats(parts);
  const lead = parts[combo.lead] || parts.blade || parts.mainBlade || parts.metalBlade;
  const type = lead?.type || '';
  const slots = comboSlots(combo.lead || leadKindOf(combo.partKeys), parts);
  const gone = slots.filter((kind) => combo.partKeys[kind] && !parts[kind]);

  return (
    '<article class="card combo-card" data-type="' + esc(type) + '">' +
    '<span class="card-serial">Combo ' + String(serial).padStart(2, '0') + '</span>' +
    '<div class="card-head"><div class="card-title">' +
    '<h3>' + esc(combo.nickname || combo.name) + '</h3>' +
    (combo.nickname ? '<p class="combo-name">' + esc(combo.name) + '</p>' : '') +
    '<p class="meta">' + (type ? badge(type) : '') +
    '<span class="pill">' + esc(combo.line || COMBO_LINES[combo.lead || 'blade'].line) + '</span>' +
    starRow(combo.rating, mine ? { action: 'combo-rate', id: combo.id } : {}) +
    '</p></div></div>' +

    '<dl class="part-list">' +
    PART_KINDS.filter((kind) => parts[kind])
      .map(
        (kind) =>
          '<div><dt>' + esc(PART_LABELS[kind]) + '</dt>' +
          '<dd title="' + esc(parts[kind].name) + '">' + esc(partName(parts[kind])) +
          codeChip(parts[kind]) + integratedNote(parts[kind]) +
          (parts[kind].type ? ' ' + badge(parts[kind].type) : '') +
          '</dd></div>'
      )
      .join('') +
    '</dl>' +

    (stats ? statsHtml(stats, ceiling, type) : '') +
    weightLine(parts, { system: combo.line }) +
    (gone.length
      ? '<p class="card-hint">Some parts are no longer on the shelf: ' +
        esc(gone.map((kind) => PART_LABELS[kind].toLowerCase()).join(', ')) + '.</p>'
      : '') +
    tagChips(combo.tags) +
    (combo.strengths
      ? '<p class="notes good"><span class="note-label">Strengths</span>' + esc(combo.strengths) + '</p>'
      : '') +
    (combo.weaknesses
      ? '<p class="notes bad"><span class="note-label">Weaknesses</span>' + esc(combo.weaknesses) + '</p>'
      : '') +

    '<div class="card-actions">' +
    (mine
      ? '<button class="ghost small" data-action="combo-edit" data-id="' + combo.id + '">Edit</button>' +
        '<button class="ghost small danger" data-action="combo-remove" data-id="' + combo.id + '">Remove</button>'
      : '') +
    '<span class="muted small">' +
    (combo.updatedAt ? new Date(combo.updatedAt).toLocaleDateString() : '') + '</span>' +
    '</div></article>'
  );
}

function filteredCombos() {
  const term = ui.search.trim().toLowerCase();
  const combos = store.data.combos.filter((combo) => {
    if (ui.comboFilter.length && !ui.comboFilter.some((tag) => (combo.tags || []).includes(tag))) {
      return false;
    }
    if (!term) return true;
    const parts = Object.values(partsOf(combo)).map((p) => partName(p) + ' ' + p.name);
    return [combo.name, combo.nickname, combo.strengths, combo.weaknesses, ...(combo.tags || []), ...parts]
      .join(' ')
      .toLowerCase()
      .includes(term);
  });

  const statOf = (combo, key) => sumPartStats(partsOf(combo))?.[key] ?? -1;
  const sorters = {
    'rating-desc': (a, b) => (b.rating || 0) - (a.rating || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)),
    'added-desc': (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
    'name-asc': (a, b) => (a.nickname || a.name).localeCompare(b.nickname || b.name),
    'weight-desc': (a, b) =>
      (comboWeight(partsOf(b), null)?.grams || 0) - (comboWeight(partsOf(a), null)?.grams || 0),
    'attack-desc': (a, b) => statOf(b, 'attack') - statOf(a, 'attack'),
    'defense-desc': (a, b) => statOf(b, 'defense') - statOf(a, 'defense'),
    'stamina-desc': (a, b) => statOf(b, 'stamina') - statOf(a, 'stamina'),
  };
  return [...combos].sort(sorters[ui.comboSort] || sorters['rating-desc']);
}

function combosView() {
  const mine = store.viewing.isSelf;
  const combos = filteredCombos();
  const tags = comboTags();
  const stale = store.serverAvailable && store.apiVersion < COMBO_API;

  let html = '';
  if (stale && mine) {
    html +=
      '<div class="notice error"><span>This server is running an older <strong>api.php</strong>. ' +
      'Upload the current one before building combinations, or they will not save.</span></div>';
  }
  if (mine && ui.builder) html += comboBuilder();

  html +=
    '<section class="toolbar">' +
    (mine && !ui.builder
      ? '<button class="primary" data-action="combo-new">New combination</button>'
      : '') +
    '<input id="search" type="search" placeholder="Filter by name, part, note..." value="' + esc(ui.search) + '">' +
    '<select id="combo-sort">' +
    [
      ['rating-desc', 'Best rated'],
      ['added-desc', 'Newest first'],
      ['name-asc', 'Name A-Z'],
      ['weight-desc', 'Heaviest'],
      ['attack-desc', 'Most attack'],
      ['defense-desc', 'Most defense'],
      ['stamina-desc', 'Most stamina'],
    ]
      .map(
        ([value, label]) =>
          '<option value="' + value + '"' + (ui.comboSort === value ? ' selected' : '') + '>' + label + '</option>'
      )
      .join('') +
    '</select>' +
    '<button class="switch' + (ui.statsMode === 'radar' ? ' on' : '') + '" data-action="stats-mode" role="switch" ' +
    'aria-checked="' + (ui.statsMode === 'radar') + '" title="Show stats as a radar chart instead of bars">' +
    '<span class="switch-label">Radar</span><span class="switch-track"><span class="switch-knob"></span></span>' +
    '</button>' +
    (tags.length
      ? '<span class="tag-filter">' +
        '<button class="chip' + (ui.comboFilter.length ? '' : ' on') + '" data-action="combo-filter" data-tag="">all</button>' +
        tags
          .map(
            ([tag, count]) =>
              '<button class="chip' + (ui.comboFilter.includes(tag) ? ' on' : '') + '" ' +
              'data-action="combo-filter" data-tag="' + esc(tag) + '">' + esc(tag) +
              ' <span class="count">' + count + '</span></button>'
          )
          .join('') +
        '</span>'
      : '') +
    '<span class="muted small">' + combos.length + '/' + store.data.combos.length + ' combos</span>' +
    '</section>';

  if (!store.data.combos.length) {
    return (
      html +
      '<div class="empty"><h2>No combinations yet</h2><p class="muted">' +
      (mine
        ? 'Press <strong>New combination</strong> and build one out of the parts on your shelf. ' +
          'The blade you pick decides the line, and the line decides what comes next.'
        : esc(store.viewing.username) + ' has not built any yet.') +
      '</p></div>'
    );
  }
  if (!combos.length) return html + '<p class="shelf-note">No combination matches these filters.</p>';

  const ceiling = statCeiling(store.data.combos.map((combo) => sumPartStats(partsOf(combo))));
  return html + '<div class="grid">' + combos.map((combo, i) => comboCard(combo, ceiling, i + 1)).join('') + '</div>';
}

/**
 * Change the tags from code. The text box is the copy captureBuilder() reads,
 * so it has to be written too, or the next redraw would read the old list back
 * and undo the change.
 */
function setBuilderTags(tags) {
  ui.builder.tags = tags;
  const input = document.getElementById('combo-tagline');
  if (input) input.value = tags.join(', ');
}

/**
 * Text the blader typed lives in the DOM until something redraws the page;
 * read it back into the builder first so a redraw never eats a half-written note.
 */
function captureBuilder() {
  if (!ui.builder) return;
  const value = (id) => document.getElementById(id)?.value;
  const nickname = value('combo-nickname');
  if (nickname !== undefined) ui.builder.nickname = nickname;
  const tagline = value('combo-tagline');
  if (tagline !== undefined) {
    ui.builder.tags = tagline
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
  }
  const strengths = value('combo-strengths');
  if (strengths !== undefined) ui.builder.strengths = strengths;
  const weaknesses = value('combo-weaknesses');
  if (weaknesses !== undefined) ui.builder.weaknesses = weaknesses;
}

/* ---------------------------------------------------------- analysis view */

function analysisView() {
  const d = distribution();
  if (!d.totalProducts) {
    return (
      '<div class="empty"><h2>Nothing to analyse yet</h2><p class="muted">' +
      (d.wishlistProducts
        ? 'Only wishlist entries so far - the analysis covers what is owned.'
        : 'Add a few beyblades first.') +
      '</p></div>'
    );
  }

  const tiles = [
    ['Products owned', d.totalProducts],
    ['Units owned', d.totalUnits],
    ['Unique parts', Object.values(d.uniqueParts).reduce((a, b) => a + b, 0)],
    ['Avg weight', d.averageWeight ? d.averageWeight.toFixed(1) + ' g' : '-'],
    ['On the wishlist', d.wishlistProducts],
  ];

  let html =
    '<div class="tiles">' +
    tiles
      .map(([label, value]) => '<div class="tile"><span class="tile-value">' + esc(value) + '</span>' +
        '<span class="tile-label">' + esc(label) + '</span></div>')
      .join('') +
    '</div>';

  html += '<div class="panels">';
  html += chartPanel('Attack type of the whole beyblade', mapToEntries(d.beyTypes), { colorFn: typeColor });
  html += chartPanel('Product line', mapToEntries(d.beySystems));
  html += chartPanel('Spin direction', mapToEntries(d.spin));
  html += chartPanel('Release', mapToEntries(d.hasbro));

  const typeAcross = new Map();
  for (const kind of PART_KINDS) {
    for (const [type, count] of d.partTypes[kind]) {
      if (type === 'Unrated') continue; // ratchets and lock chips are not typed
      typeAcross.set(type, (typeAcross.get(type) || 0) + count);
    }
  }
  html += chartPanel('Attack type across every rated part', mapToEntries(typeAcross), { colorFn: typeColor });

  for (const kind of ['blade', 'mainBlade', 'overBlade', 'metalBlade', 'assistBlade', 'bit']) {
    const map = d.partTypes[kind];
    if (map.size) {
      html += chartPanel(PART_LABELS[kind] + ' types', mapToEntries(map), { colorFn: typeColor });
    }
  }

  html += chartPanel('Ratchet height', mapToEntries(d.ratchetHeights));
  html += chartPanel('Ratchet contact points', mapToEntries(d.ratchetContacts));
  html += chartPanel('Most used bits', mapToEntries(d.bitUsage), { limit: 10 });
  html += chartPanel('Most used blades (incl. CX main and metal blades)', mapToEntries(d.bladeUsage), { limit: 10 });

  if (d.averageStats) {
    const ceiling = Math.max(d.averageStats.attack, d.averageStats.defense, d.averageStats.stamina);
    html +=
      '<section class="panel"><h3>Average stat profile</h3>' +
      '<div class="stats">' +
      statRow('ATK', d.averageStats.attack, ceiling, 'fill-attack') +
      statRow('DEF', d.averageStats.defense, ceiling, 'fill-defense') +
      statRow('STA', d.averageStats.stamina, ceiling, 'fill-stamina') +
      '</div><p class="muted small">Mean of the summed wiki stats of each product’s parts.</p></section>';
  }

  const coverage = PART_KINDS.filter((kind) => d.indexTotals[kind]).map(
    (kind) => [PART_LABELS[kind] + 's', d.uniqueParts[kind], d.indexTotals[kind]]
  );
  if (coverage.length) {
    html +=
      '<section class="panel"><h3>Catalogue coverage</h3><div class="bars">' +
      coverage
        .map(([label, owned, total]) => {
          const pct = total ? Math.round((owned / total) * 100) : 0;
          return (
            '<div class="bar-row"><span class="bar-label">' + esc(label) + '</span>' +
            '<span class="bar-track"><span class="bar-fill fill-neutral" style="width:' + Math.max(2, pct) + '%"></span></span>' +
            '<span class="bar-value">' + owned + '/' + total + '</span></div>'
          );
        })
        .join('') +
      '</div><p class="muted small">Against every part listed on the wiki, including Takara Tomy exclusives.</p></section>';
  }

  return html + '</div>';
}

function chartPanel(title, entries, options = {}) {
  return '<section class="panel"><h3>' + esc(title) + '</h3>' + barChart(entries, options) + '</section>';
}

/* ------------------------------------------------------------ bladers view */

function bladerFact(label, value) {
  return (
    '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>'
  );
}

function bladerCard(person) {
  const stats = person.stats || {};
  const isMe = auth.user && person.id === auth.user.id;
  const open = store.viewing.userId === person.id;

  return (
    '<article class="card blader-card' + (open ? ' is-open' : '') + '" ' +
    'data-type="' + esc(stats.topType || '') + '">' +
    '<div class="card-head">' +
    '<div class="avatar">' + esc(person.username.slice(0, 2).toUpperCase()) + '</div>' +
    '<div class="card-title"><h3>' + esc(person.username) + '</h3>' +
    '<p class="meta">' +
    (person.owner ? '<span class="pill qty-pill">Owner</span>' : '') +
    (isMe ? '<span class="pill">You</span>' : '') +
    (stats.topType ? badge(stats.topType) : '') +
    '</p></div></div>' +

    '<dl class="part-list">' +
    bladerFact('Beyblades', stats.products || 0) +
    bladerFact('Units', stats.units || 0) +
    bladerFact('Unique parts', stats.uniqueParts || 0) +
    bladerFact('Wishlist', stats.wishlist || 0) +
    bladerFact('Combos', stats.combos || 0) +
    bladerFact(
      'Last saved',
      stats.updatedAt ? new Date(stats.updatedAt).toLocaleDateString() : 'never'
    ) +
    '</dl>' +

    '<div class="card-actions">' +
    '<button class="ghost small" data-action="view-blader" data-user="' + esc(person.id) + '" ' +
    'data-username="' + esc(person.username) + '">' +
    (open ? 'Showing' : isMe ? 'My shelf' : 'Open shelf') +
    '</button>' +
    '</div></article>'
  );
}

function bladersView() {
  if (!store.users.length) {
    return (
      '<div class="empty"><h2>Just you so far</h2>' +
      '<p class="muted">Other accounts appear here once they register. The owner can open ' +
      'signups with the <strong>Signup</strong> button in the top bar.</p></div>'
    );
  }
  return (
    '<section class="toolbar"><span class="muted small">' +
    store.users.length + ' blader' + (store.users.length === 1 ? '' : 's') +
    ' &middot; open any shelf to browse it read-only</span></section>' +
    '<div class="grid">' + store.users.map(bladerCard).join('') + '</div>'
  );
}

/** Shown above every view while you are looking at somebody else's shelf. */
function viewingBanner() {
  if (store.viewing.isSelf) return '';
  return (
    '<div class="notice viewing">' +
    '<span>Viewing <strong>' + esc(store.viewing.username) + '</strong> &mdash; read only</span>' +
    '<button class="ghost small" data-action="view-mine">Back to my shelf</button>' +
    '</div>'
  );
}

/* -------------------------------------------------------------- detail modal */

function detailModal() {
  if (!ui.detailId) return '';
  const entry = store.data.beyblades.find((b) => b.id === ui.detailId);
  if (!entry) return '';
  const bey = entry.bey || {};
  const parts = partsOf(entry);
  const releases = Object.entries(bey.releases || {})
    .filter(([, value]) => value)
    .map(([region, value]) => '<div><dt>' + region.toUpperCase() + '</dt><dd>' + esc(value) + '</dd></div>')
    .join('');

  return (
    '<div class="modal-backdrop" data-action="close-detail">' +
    '<div class="modal" role="dialog" aria-modal="true">' +
    '<button class="modal-close" data-action="close-detail">&times;</button>' +
    '<h2>' + esc(entry.displayName) + '</h2>' +
    (isWish(entry) ? '<p class="meta"><span class="pill wish-pill">On the wishlist</span></p>' : '') +
    '<p class="muted small">Wiki page: <a href="' + esc(bey.wikiUrl) + '" target="_blank" rel="noopener">' +
    esc(bey.wikiTitle) + '</a></p>' +
    (bey.blurb ? '<p class="blurb">' + esc(bey.blurb) + '</p>' : '') +
    '<div class="modal-grid">' +
    '<dl class="facts">' +
    '<div><dt>Type</dt><dd>' + badge(bey.type) + '</dd></div>' +
    '<div><dt>Line</dt><dd>' + esc(bey.system || '-') + '</dd></div>' +
    '<div><dt>Series</dt><dd>' + esc(bey.series || '-') + '</dd></div>' +
    '<div><dt>Spin</dt><dd>' + esc(bey.spinDirection || '-') + '</dd></div>' +
    '<div><dt>Weight</dt><dd>' + esc(bey.weightText || '-') + '</dd></div>' +
    '<div><dt>Hasbro code</dt><dd>' + esc(bey.productCodes?.hasbro || 'not released by Hasbro') + '</dd></div>' +
    '<div><dt>TT code</dt><dd>' + esc(bey.productCodes?.takaraTomy || '-') + '</dd></div>' +
    releases +
    '</dl>' +
    '<div class="modal-parts">' +
    PART_KINDS.filter((k) => parts[k])
      .map((kind) => {
        const part = parts[kind];
        const ceiling = 100;
        return (
          '<div class="part-card">' +
          '<div class="part-card-head">' + partThumb(part) +
          '<div><h4>' + esc(PART_LABELS[kind]) + ': ' + esc(partName(part)) + codeChip(part) + '</h4>' +
          (partAltName(part) ? '<p class="muted small">wiki: ' + esc(partAltName(part)) + '</p>' : '') +
          integratedNote(part) +
          '</div></div>' +
          '<p class="meta">' + (part.type ? badge(part.type) : '') +
          (part.weight ? '<span class="pill">' + part.weight + ' g</span>' : '') +
          (kind === 'ratchet' && ratchetShape(part.name).height
            ? '<span class="pill">' + ratchetShape(part.name).height + ' mm</span>'
            : '') +
          (part.hasbroReleased === false ? '<span class="pill warn">import</span>' : '') +
          '</p>' +
          (Object.keys(part.stats || {}).length ? statBlockHtml(part.stats, ceiling) : '') +
          (part.blurb ? '<p class="muted small">' + esc(part.blurb.slice(0, 260)) + '</p>' : '') +
          '<a class="link" href="' + esc(part.wikiUrl) + '" target="_blank" rel="noopener">wiki page</a>' +
          '</div>'
        );
      })
      .join('') +
    '</div></div></div></div>'
  );
}

/* ------------------------------------------------------------------- footer */

/** Web 1.0 habits worth keeping: say what was saved, when, and where. */
function footer() {
  if (!auth.user) {
    return (
      '<footer class="site-foot">' +
      '<span>Private collection &middot; sign in to continue</span>' +
      '<span>Data <strong>Beyblade Wiki</strong> (CC BY-SA) &middot; fan-made, no affiliation</span>' +
      '<span class="foot-mark">OMGBB&#215;MANAGER</span>' +
      '</footer>'
    );
  }

  const units = store.data.beyblades
    .filter((b) => !isWish(b))
    .reduce((sum, b) => sum + (Number(b.qty) || 1), 0);
  const odometer = String(units)
    .padStart(5, '0')
    .split('')
    .map((d) => '<span>' + d + '</span>')
    .join('');
  const saved = store.data.updatedAt
    ? new Date(store.data.updatedAt).toLocaleString()
    : 'never';

  return (
    '<footer class="site-foot">' +
    '<span>Beys on ' +
    (store.viewing.isSelf ? 'the shelf' : esc(store.viewing.username) + '&#39;s shelf') +
    ' <span class="counter">' + odometer + '</span></span>' +
    '<span>Last saved <strong>' + esc(saved) + '</strong></span>' +
    '<span>Storage <strong>' +
    (store.serverAvailable ? 'collection.json' : 'browser only') +
    '</strong></span>' +
    '<span>Data <strong>Beyblade Wiki</strong> (CC BY-SA) &middot; fan-made, no affiliation</span>' +
    '<span class="foot-mark">OMGBB&#215;MANAGER</span>' +
    '</footer>'
  );
}

/* ------------------------------------------------------------------ render */

function authHeader() {
  return (
    '<header class="topbar">' +
    '<div class="brand"><h1>OMGBBManager</h1>' +
    '<p class="muted small">Beyblade X collection &middot; Hasbro releases</p></div>' +
    '</header>'
  );
}

let seenShelfEpoch = 0;
let seenIndexEpoch = 0;

function render() {
  captureBuilder();
  seenShelfEpoch = store.shelfEpoch;
  seenIndexEpoch = store.indexEpoch;
  if (!auth.user) {
    root.innerHTML = authHeader() + authScreen() + footer();
    const first = document.getElementById('auth-user');
    if (first && !auth.busy) first.focus();
    return;
  }

  const views = {
    collection: collectionView,
    combos: combosView,
    parts: partsView,
    analysis: analysisView,
    bladers: bladersView,
  };
  root.innerHTML =
    header() +
    busyBar() +
    '<div id="save-slot">' + saveNotices() + '</div>' +
    cataloguePrompt() +
    viewingBanner() +
    '<main class="view view-' + ui.view + '">' + views[ui.view]() + '</main>' +
    footer() +
    detailModal();
}

/* ------------------------------------------------------------------ events */

const ACTIONS = {
  view: async (el) => {
    ui.view = el.dataset.view;
    render();
    if (ui.view === 'bladers') {
      await loadUsers();
      render();
    }
  },
  'view-blader': async (el) => {
    const person = { id: el.dataset.user, username: el.dataset.username };
    setBusy(true, 'Opening ' + person.username + '...');
    try {
      await loadCollection(person, auth.user);
      ui.view = 'collection';
      ui.search = '';
      ui.builder = null;
    } catch (err) {
      ui.error = err.message;
    } finally {
      setBusy(false);
    }
  },
  'view-mine': async () => {
    setBusy(true, 'Back to your shelf...');
    try {
      await loadCollection(null, auth.user);
    } catch (err) {
      ui.error = err.message;
    } finally {
      setBusy(false);
    }
  },
  kind: (el) => {
    ui.partKind = el.dataset.kind;
    render();
  },
  fetch: () => doFetch(),
  choose: (el) => doFetch({ forceTitle: el.dataset.title }),
  confirm: (el) => confirmPending(el.dataset.status === 'wish' ? 'wish' : 'owned'),
  'cancel-pending': () => {
    ui.pending = null;
    render();
  },
  'dismiss-error': () => {
    ui.error = '';
    ui.choices = null;
    render();
  },
  detail: (el) => {
    ui.detailId = el.dataset.id;
    render();
  },
  'close-detail': (el, event) => {
    if (event.target.closest('.modal') && !event.target.closest('.modal-close')) return;
    ui.detailId = null;
    render();
  },
  remove: (el) => {
    const entry = store.data.beyblades.find((b) => b.id === el.dataset.id);
    const from = isWish(entry) ? ' from the wishlist?' : ' from the collection?';
    if (entry && confirm('Remove ' + entry.displayName + from)) {
      removeBeyblade(el.dataset.id);
      render();
    }
  },
  'qty-inc': (el) => {
    const entry = store.data.beyblades.find((b) => b.id === el.dataset.id);
    updateBeyblade(el.dataset.id, { qty: (Number(entry.qty) || 1) + 1 });
    render();
  },
  'qty-dec': (el) => {
    const entry = store.data.beyblades.find((b) => b.id === el.dataset.id);
    updateBeyblade(el.dataset.id, { qty: Math.max(1, (Number(entry.qty) || 1) - 1) });
    render();
  },
  refetch: (el) => refetchEntry(el.dataset.id),
  acquire: (el) => {
    acquireBeyblade(el.dataset.id);
    render();
  },
  'wish-it': (el) => {
    wishBeyblade(el.dataset.id);
    render();
  },
  'refresh-index': () => refreshIndex(),
  'retry-save': () => retrySave(),
  'combo-new': () => {
    ui.builder = newBuilder();
    render();
  },
  'combo-edit': (el) => {
    const combo = store.data.combos.find((c) => c.id === el.dataset.id);
    if (!combo) return;
    ui.builder = newBuilder(combo);
    render();
  },
  'combo-cancel': () => {
    ui.builder = null;
    render();
  },
  'combo-save': () => {
    captureBuilder();
    const builder = ui.builder;
    const parts = partsOf(builder);
    const slots = comboSlots(builder.lead, parts);
    // Only the slots the line actually asks for; a leftover from an earlier
    // pick (a lock chip, after switching to a plain blade) is not saved.
    const partKeys = {};
    for (const kind of slots) {
      if (builder.partKeys[kind]) partKeys[kind] = builder.partKeys[kind];
    }
    saveCombo({
      ...builder,
      partKeys,
      name: comboName(parts),
      line: COMBO_LINES[builder.lead].line,
    });
    ui.builder = null;
    render();
  },
  'combo-remove': (el) => {
    const combo = store.data.combos.find((c) => c.id === el.dataset.id);
    if (combo && confirm('Remove the combination ' + (combo.nickname || combo.name) + '?')) {
      removeCombo(combo.id);
      render();
    }
  },
  'combo-rate': (el) => {
    const combo = store.data.combos.find((c) => c.id === el.dataset.id);
    if (!combo) return;
    const value = Number(el.dataset.value);
    // Clicking the star a combo already sits on clears the rating.
    updateCombo(combo.id, { rating: combo.rating === value ? 0 : value });
    render();
  },
  'combo-rate-draft': (el) => {
    captureBuilder();
    const value = Number(el.dataset.value);
    ui.builder.rating = ui.builder.rating === value ? 0 : value;
    render();
  },
  'combo-tag-quick': (el) => {
    captureBuilder();
    const tag = el.dataset.tag;
    const tags = ui.builder.tags;
    setBuilderTags(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]);
    render();
  },
  'combo-filter': (el) => {
    const tag = el.dataset.tag;
    if (!tag) ui.comboFilter = [];
    else if (ui.comboFilter.includes(tag)) ui.comboFilter = ui.comboFilter.filter((t) => t !== tag);
    else ui.comboFilter = [...ui.comboFilter, tag];
    render();
  },
  'stats-mode': () => {
    ui.statsMode = ui.statsMode === 'radar' ? 'bars' : 'radar';
    try {
      localStorage.setItem('omgbb.statsMode', ui.statsMode);
    } catch {
      /* private mode: the choice lasts until reload */
    }
    render();
  },
  'reload-page': () => window.location.reload(),
  'recover-restore': () => {
    restoreRecovery();
    render();
  },
  'recover-discard': () => {
    discardRecovery();
    render();
  },
  'catalogue-later': () => {
    ui.cataloguePromptLater = true;
    try {
      sessionStorage.setItem('omgbb.catalogueLater', '1');
    } catch {
      /* private mode: the in-memory flag still hides it until reload */
    }
    render();
  },
  'fetch-part': (el) => fetchLoosePart(el.dataset.kind, el.dataset.name, el.dataset.title || ''),
  'auth-mode': () => {
    auth.mode = auth.mode === 'login' ? 'register' : 'login';
    auth.error = '';
    render();
  },
  logout: async () => {
    await logout();
    render();
  },
  'toggle-registration': async (el) => {
    try {
      await setRegistrationOpen(!auth.registrationOpen);
    } catch (err) {
      ui.error = err.message;
    }
    render();
  },
  export: () => {
    const blob = new Blob([exportJson()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    const who = store.viewing.username ? store.viewing.username + '-' : '';
    link.download =
      'beyblade-collection-' + who + new Date().toISOString().slice(0, 10) + '.json';
    link.click();
    URL.revokeObjectURL(link.href);
  },
  import: () => document.getElementById('import-file').click(),
};

root.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const handler = ACTIONS[target.dataset.action];
  if (!handler) return;
  if (target.tagName !== 'A') event.preventDefault();
  handler(target, event);
});

root.addEventListener('input', (event) => {
  const el = event.target;
  if (el.id === 'search') {
    ui.search = el.value;
    debouncedRender();
  } else if (el.id === 'bey-input') {
    ui.input = el.value;
  }
});

root.addEventListener('change', (event) => {
  const el = event.target;
  if (el.id === 'type-filter') {
    ui.typeFilter = el.value;
    render();
  } else if (el.id === 'sort') {
    ui.sort = el.value;
    render();
  } else if (el.id === 'shelf-filter') {
    ui.shelfFilter = el.value;
    render();
  } else if (el.id === 'show-unowned') {
    ui.showUnowned = el.checked;
    render();
  } else if (el.id === 'combo-sort') {
    ui.comboSort = el.value;
    render();
  } else if (el.id === 'combo-unowned' && ui.builder) {
    captureBuilder();
    ui.builder.includeUnowned = el.checked;
    render();
  } else if (el.dataset.slot && ui.builder) {
    captureBuilder();
    pickSlot(el.dataset.slot, el.value);
    render();
  }
});

/**
 * Record a choice from one of the builder's selects. Changing the blade can
 * change the line, so any part the new line has no slot for is dropped.
 */
function pickSlot(slot, value) {
  const builder = ui.builder;
  if (slot === 'lead') {
    const [kind, key] = value ? value.split('|') : ['blade', ''];
    const keep = key ? { [kind]: key } : {};
    // Slots shared with the previous line (ratchet, bit, ...) survive the switch.
    for (const [otherKind, otherKey] of Object.entries(builder.partKeys)) {
      if (!COMBO_LEAD_KINDS.includes(otherKind)) keep[otherKind] = otherKey;
    }
    builder.lead = kind;
    builder.partKeys = keep;
  } else if (value) {
    builder.partKeys[slot] = value;
  } else {
    delete builder.partKeys[slot];
  }
  // A fused part covers a slot that may already hold something; forget it.
  const slots = comboSlots(builder.lead, partsOf(builder));
  for (const kind of Object.keys(builder.partKeys)) {
    if (!slots.includes(kind)) delete builder.partKeys[kind];
  }
}

root.addEventListener('submit', async (event) => {
  if (event.target.id !== 'auth-form') return;
  event.preventDefault();
  auth.username = (document.getElementById('auth-user')?.value || '').trim();
  const password = document.getElementById('auth-pass')?.value || '';
  auth.notice = '';
  const signedIn = await submitCredentials(auth.username, password);
  if (signedIn) {
    await loadAll(auth.user);
    await loadUsers();
  }
  render();
});

root.addEventListener('keydown', (event) => {
  if (event.target.id === 'bey-input' && event.key === 'Enter') {
    event.preventDefault();
    doFetch();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && ui.detailId) {
    ui.detailId = null;
    render();
  }
});

document.getElementById('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await importJson(await file.text());
  } catch (err) {
    ui.error = err.message;
  }
  event.target.value = '';
  render();
});

let renderTimer = null;
function debouncedRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    render();
    const search = document.getElementById('search');
    if (search) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }, 150);
}

function typingInPage() {
  const el = document.activeElement;
  return Boolean(el && root.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/*
 * Data that arrives from another tab redraws the page - unless someone is
 * typing, in which case it waits for the next redraw. Save progress on its own
 * only touches the indicators.
 */
onChange(() => {
  if (!auth.user) return;
  const fresh = store.shelfEpoch !== seenShelfEpoch || store.indexEpoch !== seenIndexEpoch;
  if (fresh && !typingInPage()) {
    render();
    return;
  }
  updateSaveIndicators();
});

/* Signed-out visitors get the gate; the data only loads behind it. */
async function boot() {
  await refreshSession();
  if (auth.user) {
    await loadAll(auth.user);
    await loadUsers();
  }
  render();
}

window.addEventListener('omgbb:unauthorized', () => {
  if (!auth.user) return;
  sessionLost();
  render();
});

/* Other tabs: pick up their saves as they happen, and again whenever this tab is focused. */
function syncFromServer() {
  if (!auth.user) return;
  refreshOwnShelf();
  reloadIndex();
}

onBroadcast((message) => {
  if (message.type === 'shelf-saved' || message.type === 'index-saved') syncFromServer();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !auth.user) return;
  if (store.saveState.status === 'error') retrySave();
  syncFromServer();
});

window.addEventListener('beforeunload', (event) => {
  if (!store.pending.length) return;
  event.preventDefault();
  event.returnValue = '';
});

boot();
