/**
 * Everything that talks to the Beyblade Wiki.
 *
 * All traffic goes through the local /api/wiki proxy, which caches every page
 * on disk and spaces requests out. Nothing here runs automatically: each call
 * originates from a button the user pressed.
 */

import {
  PART_PAGE_PREFIX,
  PART_CATEGORIES,
  parseBeyName,
  titleCandidates,
  normalizeKey,
  abbreviate,
  firstNumber,
  searchProducts,
} from './parse.js';
import { apiFetch } from './api.js';

export const WIKI_PAGE_BASE = 'https://beyblade.fandom.com/wiki/';

export function wikiUrl(title) {
  return WIKI_PAGE_BASE + encodeURIComponent(String(title).replace(/ /g, '_'));
}

/* --------------------------------------------------------------- transport */

async function api(params, { fresh = false } = {}) {
  const query = new URLSearchParams(params);
  if (fresh) query.set('fresh', '1');
  const res = await apiFetch('wiki', { params: query });
  const payload = await res.json().catch(() => ({ error: 'malformed response' }));
  if (!res.ok) throw new Error(payload.error || 'HTTP ' + res.status);
  return payload;
}

/**
 * Ask the wiki which of these titles actually exist.
 * Returns Map<requestedTitle, resolvedTitle|null> following normalisation and redirects.
 */
export async function resolveTitles(titles, opts = {}) {
  const wanted = [...new Set(titles.filter(Boolean))].slice(0, 40);
  const result = new Map(wanted.map((t) => [t, null]));
  if (!wanted.length) return result;

  const { data } = await api(
    { action: 'query', titles: wanted.join('|'), redirects: 1, prop: 'info' },
    opts
  );
  const query = data.query || {};
  const hop = new Map();
  for (const list of [query.normalized || [], query.redirects || []]) {
    for (const entry of list) hop.set(entry.from, entry.to);
  }
  const live = new Set((query.pages || []).filter((p) => !p.missing).map((p) => p.title));

  for (const title of wanted) {
    let current = title;
    for (let i = 0; i < 4 && hop.has(current); i += 1) current = hop.get(current);
    if (live.has(current)) result.set(title, current);
  }
  return result;
}

export async function searchWiki(term, limit = 10, opts = {}) {
  const { data } = await api(
    { action: 'query', list: 'search', srsearch: term, srlimit: String(limit), srnamespace: '0' },
    opts
  );
  return (data.query?.search || []).map((hit) => hit.title);
}

export async function categoryMembers(category, opts = {}, namespace = null) {
  const titles = [];
  let cont;
  do {
    const params = { action: 'query', list: 'categorymembers', cmtitle: category, cmlimit: '500' };
    if (namespace !== null) params.cmnamespace = String(namespace);
    if (cont) params.cmcontinue = cont;
    const { data } = await api(params, opts);
    for (const member of data.query?.categorymembers || []) titles.push(member.title);
    cont = data.continue?.cmcontinue;
  } while (cont);
  return titles;
}

/* ------------------------------------------------------------ page parsing */

const domParser = new DOMParser();

function cleanText(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('sup.reference, .mw-editsection, style, script').forEach((n) => n.remove());
  clone.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  return clone.textContent
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Fandom portable infoboxes tag every row with data-source. Horizontal stat
 * groups repeat the same data-source on a <th> label and a <td> value, so only
 * elements carrying pi-data-value are read.
 */
function infoboxFields(doc) {
  const box = doc.querySelector('.portable-infobox');
  const fields = {};
  if (!box) return fields;

  for (const el of box.querySelectorAll('[data-source]')) {
    const source = el.getAttribute('data-source');
    if (!source || fields[source] !== undefined) continue;
    const valueEl = el.classList.contains('pi-data-value')
      ? el
      : el.querySelector('.pi-data-value');
    if (!valueEl || valueEl.tagName === 'TH') continue;
    const text = cleanText(valueEl);
    if (text) fields[source] = text;
  }
  return fields;
}

function firstImage(doc) {
  const img = doc.querySelector('.portable-infobox img.pi-image-thumbnail');
  if (!img) return null;
  const src = img.getAttribute('src');
  return src && src.startsWith('http') ? src : null;
}

function blurb(doc) {
  for (const p of doc.querySelectorAll('.mw-parser-output > p')) {
    const text = cleanText(p);
    if (text.length > 60) return text;
  }
  return '';
}

async function fetchPage(title, opts = {}) {
  const { data, cached, fetchedAt } = await api(
    { action: 'parse', page: title, prop: 'text' },
    opts
  );
  if (data.error) throw new Error(data.error.info || 'page not found');
  const doc = domParser.parseFromString(data.parse.text, 'text/html');
  return {
    title: data.parse.title,
    fields: infoboxFields(doc),
    image: firstImage(doc),
    blurb: blurb(doc),
    cached,
    fetchedAt,
  };
}

/* ------------------------------------------------------- field interpreters */

function lines(value) {
  return String(value || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

/** "BX-01 (Takara Tomy)\nF9580 (Hasbro)" -> { hasbro: "F9580", takaraTomy: "BX-01" } */
function productCodes(value) {
  const text = String(value || '');
  const hasbro = text.match(/([A-Z0-9]+(?:-[A-Z0-9]+)?)\s*\(Hasbro\)/i);
  const tt = text.match(/([A-Z0-9]+(?:-[A-Z0-9]+)?)\s*\(Takara\s*Tomy\)/i);
  return { hasbro: hasbro ? hasbro[1] : null, takaraTomy: tt ? tt[1] : null };
}

/** The "Also Known As" row carries both the Hasbro name and short part codes. */
function akaInfo(value) {
  const all = lines(value);
  const hasbroLine = all.find((l) => /\(Hasbro[^)]*\)/i.test(l));
  // Codes are one to three letters, capitalised: "D", "GB", and mixed ones
  // such as the ratchet-integrated bit "Tr".
  const codeLine = all.find((l) => /^[A-Z][A-Za-z]{0,2}$/.test(l));
  return {
    hasbroName: hasbroLine ? hasbroLine.replace(/\s*\(Hasbro[^)]*\)\s*/i, '').trim() : null,
    code: codeLine || null,
    all,
  };
}

function releases(fields) {
  return {
    us: fields.ReleaseUS || null,
    ca: fields.ReleaseCA || null,
    eu: fields.ReleaseEU || null,
    au: fields.ReleaseAU || null,
    jp: fields.ReleaseJP || null,
  };
}

function statBlock(fields) {
  const stats = {
    attack: firstNumber(fields.AttackStat),
    defense: firstNumber(fields.DefenseStat),
    stamina: firstNumber(fields.StaminaStat),
    dash: firstNumber(fields.DashStat),
    burst: firstNumber(fields.BurstResistanceStat),
    height: firstNumber(fields.HeightStat),
  };
  for (const key of Object.keys(stats)) if (stats[key] === null) delete stats[key];
  return stats;
}

/** Is this something Hasbro actually put on shelves in the west? */
function hasbroAvailability(fields, codes) {
  const rel = releases(fields);
  return Boolean(codes.hasbro || rel.us || rel.ca);
}

function buildPartRecord(kind, page) {
  const f = page.fields;
  const codes = productCodes(f.ProductCode);
  const aka = akaInfo(f.AKA);
  const name = f.Name || page.title.replace(/^.*? - /, '');
  // Only bits and assist blades are written as letter codes in product names.
  const codeKind = kind === 'bit' || kind === 'assistBlade';
  return {
    kind,
    name,
    // "Ratchet-Integrated Blade" / "Ratchet-Integrated Bit" for the fused pieces.
    classification: f.Classification || null,
    code: aka.code || (codeKind ? abbreviate(name) : null),
    hasbroName: aka.hasbroName || null,
    type: f.Type || null,
    spinDirection: f.SpinDirection || null,
    weight: firstNumber(f.Weight),
    weightText: f.Weight || null,
    system: f.System || null,
    series: f.Series || null,
    stats: statBlock(f),
    productCodes: codes,
    releases: releases(f),
    hasbroReleased: hasbroAvailability(f, codes),
    wboLegal: f.XStandard ? !/[x✘❌]/i.test(f.XStandard) : null,
    blurb: page.blurb,
    image: page.image,
    wikiTitle: page.title,
    wikiUrl: wikiUrl(page.title),
    fetchedAt: new Date().toISOString(),
  };
}

function buildBeyRecord(page) {
  const f = page.fields;
  const codes = productCodes(f.ProductCode);
  const aka = akaInfo(f.AKA);
  const partRefs = {};
  if (f.LockChip) partRefs.lockChip = f.LockChip.split('\n')[0];
  if (f.MainBlade) partRefs.mainBlade = f.MainBlade.split('\n')[0];
  // Custom Line Expand Blades replace the Main Blade with an Over Blade and a Metal Blade.
  if (f.OverBlade) partRefs.overBlade = f.OverBlade.split('\n')[0];
  if (f.MetalBlade) partRefs.metalBlade = f.MetalBlade.split('\n')[0];
  if (f.AssistBlade) partRefs.assistBlade = f.AssistBlade.split('\n')[0];
  const blade = f.BladeX || f.Blade;
  if (!partRefs.lockChip && blade) partRefs.blade = blade.split('\n')[0];
  // Fused pieces live on their own wiki pages but play the part they replace:
  // a Ratchet-Integrated Blade is the blade, a Ratchet-Integrated Bit the ratchet.
  const partPages = {};
  if (!partRefs.lockChip && !partRefs.blade && f.RatchetBlade) {
    partRefs.blade = f.RatchetBlade.split('\n')[0];
    partPages.blade = 'Ratchet-Integrated Blade';
  }
  if (f.Ratchet) {
    partRefs.ratchet = f.Ratchet.split('\n')[0];
  } else if (f.RatchetBit) {
    partRefs.ratchet = f.RatchetBit.split('\n')[0];
    partPages.ratchet = 'Ratchet-Integrated Bit';
  }
  if (f.Bit) partRefs.bit = f.Bit.split('\n')[0];

  return {
    wikiName: f.Name || page.title,
    hasbroName: aka.hasbroName || null,
    type: f.Type || null,
    spinDirection: f.SpinDirection || null,
    weight: firstNumber(f.Weight),
    weightText: f.Weight || null,
    system: f.System || null,
    series: f.Series || null,
    productCodes: codes,
    releases: releases(f),
    hasbroReleased: hasbroAvailability(f, codes),
    price: f.Price || null,
    blurb: page.blurb,
    image: page.image,
    partRefs,
    partPages,
    wikiTitle: page.title,
    wikiUrl: wikiUrl(page.title),
    fetchedAt: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------- public actions */

/**
 * Fetch one part page. Blades sometimes exist as separate Hasbro / Takara Tomy
 * pages; the Hasbro one wins because that is the release the collection tracks.
 */
export async function fetchPart(kind, name, opts = {}, pagePrefix = null) {
  const base = (pagePrefix || PART_PAGE_PREFIX[kind]) + ' - ' + name;
  const candidates = [base + ' (Hasbro)', base, base + ' (Takara Tomy)'];
  const resolved = await resolveTitles(candidates, opts);
  const title = candidates.map((c) => resolved.get(c)).find(Boolean);
  if (!title) {
    // Fall back to a bare record so the part still shows up in the lists.
    return {
      kind,
      name,
      code: kind === 'bit' || kind === 'assistBlade' ? abbreviate(name) : null,
      stats: {},
      unresolved: true,
      wikiUrl: wikiUrl(base),
      fetchedAt: new Date().toISOString(),
    };
  }
  return buildPartRecord(kind, await fetchPage(title, opts));
}

/* ------------------------------------------------------ generation filter */

/*
 * The wiki covers every generation (plastics, Metal Fight, Burst, X), and its
 * search happily mixes them. Only Beyblade X products belong here.
 *
 * Two signals, either is enough:
 *   - the page sits in "Beyblade X Beyblades" or "Beyblade X (Season N) Beyblades"
 *   - the title ends in an X ratchet + bit ("DranSword 3-60F", "RhinoReaper C4-55D"),
 *     a shape no older generation uses - this catches pages not yet categorised.
 */
const X_PRODUCT_CATEGORY = /^Category:Beyblade X( \(Season \d+\))? Beyblades$/;
const X_PRODUCT_TITLE = /\s[A-Z]{0,2}(?:\d{1,2}|M)-\d{2}[A-Za-z]{1,3}$/;

/** Keep only titles that are Beyblade X products, preserving order. One request. */
export async function keepBeybladeX(titles, opts = {}) {
  // " - " marks part pages and episodes ("Blade - DranSword", "Beyblade X - Episode 27").
  const wanted = [...new Set(titles.filter((t) => t && !t.includes(' - ')))].slice(0, 40);
  if (!wanted.length) return [];

  const { data } = await api(
    { action: 'query', titles: wanted.join('|'), prop: 'categories', cllimit: 'max', redirects: 1 },
    opts
  );
  const query = data.query || {};
  const hop = new Map();
  for (const list of [query.normalized || [], query.redirects || []]) {
    for (const entry of list) hop.set(entry.from, entry.to);
  }
  const tagged = new Set(
    (query.pages || [])
      .filter((page) => (page.categories || []).some((c) => X_PRODUCT_CATEGORY.test(c.title)))
      .map((page) => page.title)
  );

  return wanted.filter((title) => {
    let current = title;
    for (let i = 0; i < 4 && hop.has(current); i += 1) current = hop.get(current);
    return tagged.has(current) || X_PRODUCT_TITLE.test(title);
  });
}

/* ------------------------------------------------------------ hasbro names */

/** One "|Param = value" line from an infobox's wikitext. */
function infoboxParam(wikitext, name) {
  const match = String(wikitext || '').match(new RegExp('^\\s*\\|\\s*' + name + '\\s*=(.*)$', 'mi'));
  return match ? match[1].trim() : '';
}

/**
 * The Hasbro name from an AKA value: "Wand Wizard 5-70DB ([[Hasbro]])" on a
 * product page, "Wand Wizard (Hasbro)" on a part page.
 */
export function hasbroFromAka(aka) {
  for (const piece of String(aka || '').split(/<br\s*\/?>|\n/i)) {
    const match = piece.match(/^(.*?)\s*\(\s*(?:\[\[)?Hasbro(?:\]\])?[^)]*\)\s*$/i);
    if (match && match[1].trim()) return match[1].replace(/\[\[|\]\]/g, '').trim();
  }
  return null;
}

/**
 * Hasbro names and availability for many pages at once. The infobox sits in a
 * page's first section, so 50 pages cost one small request.
 */
export async function fetchInfoboxNames(titles, { fresh = false, onProgress = () => {}, label = 'pages' } = {}) {
  const out = new Map();
  const unique = [...new Set(titles.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    onProgress('Reading Hasbro names: ' + label + ' ' + (i + batch.length) + '/' + unique.length + '...');
    let cont = null;
    do {
      const params = {
        action: 'query',
        prop: 'revisions',
        rvprop: 'content',
        rvslots: 'main',
        rvsection: '0',
        titles: batch.join('|'),
      };
      if (cont) Object.assign(params, cont);
      const { data } = await api(params, { fresh });
      for (const page of data.query?.pages || []) {
        const content = page.revisions?.[0]?.slots?.main?.content;
        if (content === undefined) continue;
        const codes = infoboxParam(content, 'ProductCode');
        out.set(page.title, {
          hasbro: hasbroFromAka(infoboxParam(content, 'AKA')),
          hasbroReleased:
            /\(\s*(?:\[\[)?Hasbro/i.test(codes) ||
            Boolean(infoboxParam(content, 'ReleaseUS')) ||
            Boolean(infoboxParam(content, 'ReleaseCA')),
        });
      }
      cont = data.continue?.rvcontinue
        ? { rvcontinue: data.continue.rvcontinue, continue: data.continue.continue }
        : null;
    } while (cont);
  }
  return out;
}

/* ----------------------------------------------------------- product lookup */

function catalogueEntries(productIndex) {
  if (!Array.isArray(productIndex)) return null;
  const entries = productIndex
    .map((p) => (typeof p === 'string' ? { title: p, hasbro: null } : p))
    .filter((p) => p && p.title);
  return entries.length ? entries : null;
}

/**
 * Full lookup for a product name.
 *
 * Resolution order: the local catalogue (exact wiki or Hasbro name, then ranked
 * partial matches), then exact wiki titles, then wiki search. When nothing is
 * certain the caller gets choices rather than a guess - Beyblade X only, each
 * carrying its Hasbro name where there is one.
 */
export async function fetchBeyblade(input, options = {}) {
  const {
    fresh = false,
    onProgress = () => {},
    knownParts = {},
    forceTitle = null,
    productIndex = null,
  } = options;
  const opts = { fresh };
  const parsed = parseBeyName(input);

  let title = forceTitle;
  if (!title) {
    const candidates = parsed ? titleCandidates(parsed) : [String(input).trim()];
    const wantedKeys = new Set(candidates.map(normalizeKey));
    wantedKeys.add(normalizeKey(input));
    const index = catalogueEntries(productIndex);

    // The catalogue answers most lookups without touching the wiki: a full name
    // in either spelling directly, a partial one as ranked choices.
    const suggestions = index ? searchProducts(input, index) : [];
    if (index) {
      const hit = index.find(
        (p) => wantedKeys.has(normalizeKey(p.title)) || (p.hasbro && wantedKeys.has(normalizeKey(p.hasbro)))
      );
      if (hit) title = hit.title;
    }

    if (!title && !parsed && suggestions.length) {
      return { needsChoice: true, options: suggestions, parsed, source: 'index' };
    }

    // A full name the catalogue does not know may be newer than the last sync.
    if (!title) {
      onProgress('Looking up "' + input + '" on the wiki...');
      const resolved = await resolveTitles(candidates, opts);
      title = candidates.map((c) => resolved.get(c)).find(Boolean) || null;

      // A parsed name has an X ratchet, so its page is X by construction. A bare
      // name ("Storm Pegasus") could land on an older generation's page exactly.
      if (title && !parsed && !(await keepBeybladeX([title], opts)).length) title = null;
    }

    if (!title && suggestions.length) {
      return { needsChoice: true, options: suggestions, parsed, source: 'index' };
    }

    if (!title) {
      onProgress('No exact page. Searching Beyblade X...');
      const hits = await keepBeybladeX(await searchWiki(input, 25, opts), opts);
      title = hits.find((hit) => wantedKeys.has(normalizeKey(hit))) || null;
      if (!title) {
        const options = hits.slice(0, 12).map((hit) => ({ title: hit, hasbro: null }));
        return { needsChoice: true, options, parsed, source: 'wiki' };
      }
    }
  }

  onProgress('Reading ' + title + '...');
  const bey = buildBeyRecord(await fetchPage(title, opts));

  const parts = {};
  const entries = Object.entries(bey.partRefs);
  let step = 0;
  for (const [kind, name] of entries) {
    step += 1;
    const cached = knownParts[kind + ':' + normalizeKey(name)];
    if (cached && !fresh) {
      parts[kind] = cached;
      continue;
    }
    onProgress('Fetching ' + PART_PAGE_PREFIX[kind] + ' "' + name + '" (' + step + '/' + entries.length + ')...');
    parts[kind] = await fetchPart(kind, name, opts, (bey.partPages || {})[kind] || null);
  }

  return { bey, parts, parsed };
}

/* ---------------------------------------------------------------- catalogue */

/**
 * Every Beyblade X product with its Hasbro name. The category names are
 * discovered rather than hard-coded, so a new season is picked up by the next sync.
 */
export async function fetchProducts({ onProgress = () => {}, fresh = false } = {}) {
  const { data } = await api(
    { action: 'query', list: 'allcategories', acprefix: 'Beyblade X', aclimit: '500' },
    { fresh }
  );
  const categories = (data.query?.allcategories || [])
    .map((c) => 'Category:' + c.category)
    .filter((c) => X_PRODUCT_CATEGORY.test(c));

  const found = new Set();
  for (const category of categories) {
    onProgress('Indexing ' + category + '...');
    for (const title of await categoryMembers(category, { fresh }, 0)) {
      if (!title.includes(' - ')) found.add(title);
    }
  }
  const titles = [...found].sort((a, b) => a.localeCompare(b));
  const names = await fetchInfoboxNames(titles, { fresh, onProgress, label: 'products' });
  return titles.map((title) => {
    const info = names.get(title) || {};
    return { title, hasbro: info.hasbro || null, hasbroReleased: Boolean(info.hasbroReleased) };
  });
}

/* Bits and ratchets sell under the same names everywhere; blade pieces may not. */
const RENAMED_PART_KINDS = ['blade', 'lockChip', 'mainBlade', 'overBlade', 'metalBlade', 'assistBlade'];

/**
 * Rebuild the catalogue: every part the wiki knows about, every Beyblade X
 * product, and their Hasbro names (about 25 requests).
 */
export async function fetchPartIndex({ onProgress = () => {}, fresh = false } = {}) {
  const categories = {};
  for (const [kind, category] of Object.entries(PART_CATEGORIES)) {
    const titles = [];
    for (const listing of [].concat(category)) {
      onProgress('Indexing ' + listing + '...');
      titles.push(...(await categoryMembers(listing, { fresh })));
    }
    categories[kind] = titles
      .filter((t) => t.includes(' - '))
      .map((t) => ({
        name: t.slice(t.indexOf(' - ') + 3).replace(/\s*\((Hasbro|Takara Tomy)\)$/, ''),
        title: t,
        variant: (t.match(/\((Hasbro|Takara Tomy)\)$/) || [])[1] || null,
      }));
  }

  const renamed = RENAMED_PART_KINDS.flatMap((kind) => (categories[kind] || []).map((p) => p.title));
  const names = await fetchInfoboxNames(renamed, { fresh, onProgress, label: 'parts' });
  for (const kind of RENAMED_PART_KINDS) {
    for (const part of categories[kind] || []) {
      const info = names.get(part.title);
      if (info && info.hasbro) part.hasbro = info.hasbro;
    }
  }

  const products = await fetchProducts({ onProgress, fresh });
  const now = new Date().toISOString();
  return { schema: 2, updatedAt: now, catalogueUpdatedAt: now, categories, products };
}
