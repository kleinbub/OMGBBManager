/**
 * Pure helpers for turning a product name a human typed into structured parts,
 * and for guessing the wiki page titles that might describe it.
 *
 * Naming conventions this has to cope with:
 *   Basic / Unique line   "Dran Sword 3-60F"      wiki title: "DranSword 3-60F"
 *   Custom line (CX)      "Reaper Rhino C4-55D"   wiki title: "RhinoReaper C4-55D"
 *
 * Hasbro prints CX names main-blade-first, the wiki titles them lock-chip-first,
 * so both orderings are treated as candidates and the wiki decides which is real.
 */

/*
 * Custom Line blades are Lock Chip + Main Blade + Assist Blade. Custom Line
 * Expand Blades replace the Main Blade with an Over Blade and a Metal Blade.
 */
export const PART_KINDS = [
  'blade',
  'lockChip',
  'mainBlade',
  'overBlade',
  'metalBlade',
  'assistBlade',
  'ratchet',
  'bit',
];

export const PART_LABELS = {
  blade: 'Blade',
  lockChip: 'Lock Chip',
  mainBlade: 'Main Blade',
  overBlade: 'Over Blade',
  metalBlade: 'Metal Blade',
  assistBlade: 'Assist Blade',
  ratchet: 'Ratchet',
  bit: 'Bit',
};

/** Wiki page prefix for each part kind, e.g. "Bit - Dot". */
export const PART_PAGE_PREFIX = PART_LABELS;

/**
 * Category pages that list every known part of a kind. A Ratchet-Integrated
 * Blade is filed as a blade, and a Ratchet-Integrated Bit as a ratchet.
 */
export const PART_CATEGORIES = {
  blade: ['Category:Blades', 'Category:Ratchet-Integrated Blades'],
  lockChip: 'Category:Lock Chips',
  mainBlade: 'Category:Main Blades',
  overBlade: 'Category:Over Blades',
  metalBlade: 'Category:Metal Blades',
  assistBlade: 'Category:Assist Blades',
  ratchet: ['Category:Ratchets', 'Category:Ratchet-Integrated Bits'],
  bit: 'Category:Bits',
};

/* ------------------------------------------------------------ custom combos */

/**
 * Which piece a fused part brings along with it, or null for an ordinary one.
 * A Ratchet-Integrated Blade is a blade with the ratchet built in; a
 * Ratchet-Integrated Bit sits in the ratchet slot and brings the bit.
 */
export function integratedExtra(part) {
  const classification = String(part?.classification || '');
  if (!/Ratchet-Integrated/i.test(classification)) return null;
  return /Bit$/i.test(classification) ? 'bit' : 'ratchet';
}

/**
 * A combination is built from one of three starting pieces, and that piece
 * decides the line and therefore which slots follow it.
 */
export const COMBO_LINES = {
  blade: { line: 'Basic / Unique Line', slots: ['blade', 'ratchet', 'bit'] },
  mainBlade: {
    line: 'Custom Line',
    slots: ['lockChip', 'mainBlade', 'assistBlade', 'ratchet', 'bit'],
  },
  overBlade: {
    line: 'Custom Line Expand',
    slots: ['lockChip', 'overBlade', 'metalBlade', 'assistBlade', 'ratchet', 'bit'],
  },
};

/** The blade pieces a combination can start from, in the order they are offered. */
export const COMBO_LEAD_KINDS = ['blade', 'mainBlade', 'overBlade'];

/**
 * The slots to fill for a combination, given its starting piece and whatever
 * has been chosen so far. Fused parts remove the slot they already cover.
 */
export function comboSlots(lead, parts = {}) {
  const spec = COMBO_LINES[lead] || COMBO_LINES.blade;
  let slots = spec.slots.slice();
  if (integratedExtra(parts[lead]) === 'ratchet') slots = slots.filter((k) => k !== 'ratchet');
  if (integratedExtra(parts.ratchet) === 'bit') slots = slots.filter((k) => k !== 'bit');
  return slots;
}

/**
 * The name a combination goes by: blade, then ratchet and bit code glued
 * together the way the boxes print them - "Wand Wizard 5-70DB",
 * "Reaper Rhino C4-55D". Fused parts keep their own spelling: a blade with
 * the ratchet built in is followed by the loose bit code ("Rocket Griffon H"),
 * and a ratchet-integrated bit trails as a word of its own ("... A Tr").
 *
 * Every chosen piece is named, including the over blade Hasbro leaves off its
 * boxes, because a combination has to be identifiable from its name alone.
 */
export function comboName(parts) {
  const label = (part) => (part && (part.hasbroName || part.name)) || '';
  const codeOf = (part) => (part ? part.code || abbreviate(label(part)) : '');

  const head = ['metalBlade', 'overBlade', 'mainBlade', 'lockChip', 'blade']
    .map((kind) => label(parts[kind]))
    .filter(Boolean)
    .join(' ');

  const ratchet = parts.ratchet;
  const ratchetIsBit = integratedExtra(ratchet) === 'bit';
  const number = ratchet && !ratchetIsBit ? String(ratchet.name) : '';
  const bitCode = parts.bit ? codeOf(parts.bit) : '';
  const words = [head, (parts.assistBlade ? codeOf(parts.assistBlade) : '') + number + (number ? bitCode : '')];
  if (!number && bitCode) words.push(bitCode);
  if (ratchetIsBit) words.push(ratchet.code || label(ratchet));
  return words.filter(Boolean).join(' ').trim();
}

/** Loose key used to compare names typed by humans with names from the wiki. */
export function normalizeKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function partKey(kind, name) {
  return kind + ':' + normalizeKey(name);
}

/** "RhinoReaper" -> ["Rhino", "Reaper"]; leaves already-separate words alone. */
export function splitCamel(token) {
  const matches = String(token).match(/[A-Z][a-z0-9]*|[a-z0-9]+/g);
  if (!matches || matches.length < 2) return [token];
  return matches;
}

/** "Gear Ball" -> "GB", "Dot" -> "D". Used only when the wiki has no explicit code. */
export function abbreviate(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.map((w) => w[0].toUpperCase()).join('');
}

const SYSTEM_MARKERS = { cx: 'CX', ux: 'UX', bx: 'BX' };

/**
 * Break a typed product name into blade words, ratchet, bit code and (for CX)
 * assist-blade code.
 *
 * Returns null when no ratchet-looking chunk is present, which is the signal
 * that the input should be handed straight to wiki search instead.
 */
export function parseBeyName(input) {
  const raw = String(input || '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;

  // A trailing "CX"/"UX"/"BX" is a line marker people add, not part of the name.
  let working = raw;
  let systemHint = null;
  const markerMatch = working.match(/\s(cx|ux|bx)$/i);
  if (markerMatch) {
    systemHint = SYSTEM_MARKERS[markerMatch[1].toLowerCase()];
    working = working.slice(0, markerMatch.index).trim();
  }

  // [assist code] [ratchet] [bit code] at the end, with or without spaces.
  const tail = working.match(
    /(?:^|\s)(?:([A-Za-z]{1,2})\s*)?([0-9]{1,2}|[A-Z])-([0-9]{2})\s*([A-Za-z]{1,3})?\s*$/
  );
  if (!tail) return null;

  const [, assistRaw, ratchetHead, ratchetHeight, bitRaw] = tail;
  const bladePart = working.slice(0, tail.index).trim();
  if (!bladePart) return null;

  let bladeWords = bladePart.split(' ').filter(Boolean);
  // A single glued token like "RhinoReaper" still describes two CX blade parts.
  if (bladeWords.length === 1) bladeWords = splitCamel(bladeWords[0]);

  const assistCode = assistRaw ? assistRaw.toUpperCase() : null;
  const isCX = Boolean(assistCode) || systemHint === 'CX' || bladeWords.length >= 3;

  // "Reaper Rhino C 4-55D": the assist code may have been split off as its own word.
  let resolvedAssist = assistCode;
  if (!resolvedAssist && isCX && bladeWords.length >= 3) {
    const last = bladeWords[bladeWords.length - 1];
    if (/^[A-Za-z]{1,2}$/.test(last)) {
      resolvedAssist = last.toUpperCase();
      bladeWords = bladeWords.slice(0, -1);
    }
  }

  return {
    raw,
    systemHint,
    isCX: Boolean(resolvedAssist) || systemHint === 'CX' || bladeWords.length >= 3,
    bladeWords,
    assistCode: resolvedAssist,
    ratchet: ratchetHead + '-' + ratchetHeight,
    bitCode: bitRaw ? bitRaw.toUpperCase() : '',
  };
}

/**
 * Candidate wiki page titles for a parsed name, most likely first.
 * Both blade-word orderings are offered because Hasbro and the wiki disagree.
 */
export function titleCandidates(parsed) {
  if (!parsed) return [];
  const suffix = (parsed.assistCode || '') + parsed.ratchet + parsed.bitCode;
  const joined = parsed.bladeWords.join('');
  const out = [];

  const push = (title) => {
    const clean = title.trim().replace(/\s+/g, ' ');
    if (clean && !out.includes(clean)) out.push(clean);
  };

  push(joined + ' ' + suffix);
  if (parsed.bladeWords.length === 2) {
    // Hasbro CX ordering is the reverse of the wiki ordering.
    push([...parsed.bladeWords].reverse().join('') + ' ' + suffix);
  }
  if (parsed.bladeWords.length === 3) {
    const [a, b, c] = parsed.bladeWords;
    push(a + b + c + ' ' + suffix);
    push(b + a + c + ' ' + suffix);
  }
  // Spaced spelling, in case the wiki keeps the words apart.
  push(parsed.bladeWords.join(' ') + ' ' + suffix);
  push(parsed.raw);
  return out;
}

/** First number in a messy wiki value such as "43.2 grams (first mold)". */
export function firstNumber(text) {
  const match = String(text || '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Ratchet "4-55" -> { contacts: 4, height: 55 }. */
export function ratchetShape(name) {
  const match = String(name || '').match(/^([0-9]{1,2}|[A-Z])-([0-9]{2})$/);
  if (!match) return { contacts: null, height: null };
  return {
    contacts: /^\d+$/.test(match[1]) ? Number(match[1]) : match[1],
    height: Number(match[2]),
  };
}

/* ------------------------------------------------------- partial matching */

/** True when a and b differ by at most one insertion, deletion or substitution. */
function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Does any stretch of hay spell token with one typo at most? */
function fuzzyContains(hay, token) {
  for (let len = token.length - 1; len <= token.length + 1; len += 1) {
    for (let start = 0; start + len <= hay.length; start += 1) {
      if (withinOneEdit(hay.slice(start, start + len), token)) return true;
    }
  }
  return false;
}

/** The name a product is shown under: Hasbro's where Hasbro has one. */
export function productLabel(item) {
  return (item && (item.hasbro || item.title)) || '';
}

/**
 * Rank catalogue products against a loosely typed name.
 *
 * Each product is matched on both its wiki (Takara Tomy) title and its Hasbro
 * name, squashed and lowercase, so spacing, word order and CamelCase gluing do
 * not matter: "pegasus" finds "AeroPegasus 3-70A", "wizardrod" and "wand wizard"
 * both find "Wand Wizard 5-70DB". Words of five letters or more also survive
 * one typo ("pegasus" finds "StormPegasis 3-70RA"). Words that match nothing
 * simply score nothing, so the rest of the name still counts.
 *
 * Accepts the old plain-title catalogue as well as { title, hasbro } entries,
 * and always returns entries.
 */
export function searchProducts(query, products, limit = 12) {
  const words = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (!words.length || !Array.isArray(products)) return [];

  const scored = [];
  for (const raw of products) {
    const item = typeof raw === 'string' ? { title: raw, hasbro: null } : raw;
    if (!item || !item.title) continue;
    const hays = [normalizeKey(item.title)];
    if (item.hasbro) hays.push(normalizeKey(item.hasbro));

    let score = 0;
    let missed = 0;
    let meaningful = false;
    for (const word of words) {
      // Lone digits and letters ("3", "f") help ranking but cannot carry a match.
      const weight = word.length >= 3 ? word.length : 0.5;
      if (hays.some((hay) => hay.includes(word))) {
        score += weight + (hays.some((hay) => hay.startsWith(word)) ? 1 : 0);
        if (word.length >= 3) meaningful = true;
      } else if (word.length >= 5 && hays.some((hay) => fuzzyContains(hay, word))) {
        score += weight * 0.6;
        meaningful = true;
      } else {
        missed += 1;
      }
    }
    if (meaningful) scored.push({ item, score, missed });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.missed - b.missed ||
      productLabel(a.item).length - productLabel(b.item).length ||
      productLabel(a.item).localeCompare(productLabel(b.item))
  );
  return scored.slice(0, limit).map((entry) => entry.item);
}
