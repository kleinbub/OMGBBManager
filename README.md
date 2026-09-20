# OMGBBManager

A small self-contained web app for managing a **Beyblade X** collection, focused on
**Hasbro releases**. It pulls product data from the
[Beyblade Wiki](https://beyblade.fandom.com/wiki/Main_Page) — but only when you press a
button — and stores everything as plain JSON.

## Running it

```bash
node server.js
```

Then open <http://localhost:4173>. No dependencies, no build step; Node 18+ is all you need.
On Windows you can double-click `start.bat`.

## What it does

### Collection view

Type a product name the way it is printed on the box and press **Fetch from wiki**:

- `Reaper Rhino C4-55D` (Hasbro CX spelling)
- `Reaper Rhino C 4-55D CX` (spaces and a line marker are fine)
- `Dran Sword 3-60F` / `Sword Dran 3-60F`

The app parses the name, finds the wiki page, and reads the infobox: attack type, weight,
spin direction, product line, Hasbro and Takara Tomy product codes, release dates, and the
list of parts. It then fetches each **part** page for its individual stats.

A preview appears first — set quantity and notes, then **Add to collection**. Nothing is
stored until you confirm.

**Details** on a card opens the full record: everything from the beyblade's infobox, and one
panel per part with its picture, stats, weight and blurb.

The **Radar** switch in the toolbar draws each card's stats as a radar chart instead of bars -
ATK, DEF and STA, plus DASH and BRST when the parts have them - on one scale shared by the whole
collection, so shapes compare fairly. The choice is remembered in this browser. Both forms end
with **PWR**, every stat added up, as a single number to compare whole beyblades by.

Names are shown the Hasbro way. `HellsScythe 4-60T` on the wiki is displayed as
**Scythe Incendio 4-60T**, `DranSword` as **Sword Dran**, with the wiki name kept alongside.

When the name does not match a page exactly, the app offers the closest pages to pick from -
**Beyblade X products only**. The wiki covers every generation and its search mixes them, so
each suggestion is checked against the wiki's Beyblade X categories (all seasons) or the X
ratchet-and-bit naming, and Metal Fight, Burst, parts, episodes and characters are dropped.

Partial names work too, and without asking the wiki. **Sync index** also downloads the list of
every Beyblade X product (about 280 titles), and suggestions are ranked locally against it:
word order, spacing and glued names do not matter (`pegasus` finds `AeroPegasus 3-70A`,
`sword dran` finds `DranSword 3-60F`), longer words survive a typo (`pegasus` also finds
`StormPegasis 3-70RA`), and a Hasbro-only word such as `Incendio` simply does not count against
the rest of the name. A name the list does not know yet - a product newer than your last sync -
still falls back to the wiki.

Names are shown the Hasbro way everywhere - suggestions, cards, parts, charts - with the wiki
(Takara Tomy) name in small type beside them for cross-referencing. Either spelling can be typed:
`WizardRod` and `Wand Wizard` both suggest **Wand Wizard 5-70DB** *(WizardRod 5-70DB)*. Products
Hasbro never released keep their wiki name and are marked *Takara Tomy only*.

The catalogue remembers when it was last downloaded (`catalogueUpdatedAt`, shown in the top
bar). When that is more than **5 days** ago - or the catalogue was never downloaded, or predates
partial search - a banner offers **Update now**. It never updates on its own: wiki traffic
stays button-driven. **Later** hides the banner for the rest of the browser session.

### Combos view

Where the collection holds the combinations Hasbro sells in a box, this view holds the ones
you put together yourself, out of the parts already on your shelf.

Pick the **blade** first: it decides the line, and the line decides which slots follow.

| Blade you pick | Slots that follow |
| --- | --- |
| Blade (Basic / Unique Line) | Ratchet, Bit |
| Main Blade (Custom Line) | Lock Chip, Assist Blade, Ratchet, Bit |
| Over Blade (Custom Line Expand) | Lock Chip, Metal Blade, Assist Blade, Ratchet, Bit |

Fused parts take their slot with them: choose a **Ratchet-Integrated Blade** such as Rocket
Griffon and the ratchet slot disappears; choose **Turbo** or **Operate** in the ratchet slot
and the bit slot does. The builder says *ratchet built in* / *bit built in* so it is clear
why a slot is missing.

The selects offer the parts you actually own; tick **also offer parts I do not own yet** to
add wished-for parts and anything fetched loose from the catalogue.

Each combination gets:

- a **name** built as the boxes print it - `Buster Dran 4-60DB`, `Reaper Rhino C4-55D`,
  `Rocket Griffon H` - rebuilt whenever you change a part
- an optional **nickname**, shown as the card's title with the real name underneath
- **tags** (`meta`, `test`, `funsies`, ... - anything you type, comma separated). Tags already
  in use are offered as chips under the box; clicking a tag anywhere - the toolbar row or a
  card - filters the view by it
- a **rating** out of five stars, clickable straight on the card; clicking the star it already
  sits on clears it
- **strengths** and **weaknesses**, for what you learn as you battle with it
- summed stats (bars or radar, same switch as the collection) and total weight

Combinations are part of the shelf, so other bladers can see yours read-only, and yours travel
with **Export** / **Import**.

### Parts view

Every part in the collection, grouped by kind, each row led by the wiki's picture of the piece,
with how many you own and which beyblades they came from:

- **Blades** (single-piece, Basic/Unique line)
- **Lock Chips**, **Main Blades**, **Over Blades**, **Metal Blades**, **Assist Blades** - the
  pieces of Custom Line blades: Lock Chip + Main Blade + Assist Blade, or for Expand Blades
  Lock Chip + Over Blade + Metal Blade + Assist Blade
- **Ratchets**
- **Bits**

Fused pieces count as the part they replace: a **Ratchet-Integrated Blade** (Unique Line
Expand Blades such as Rocket Griffon) is listed as a blade, and a **Ratchet-Integrated Bit**
(Turbo, Operate) as a ratchet, each marked *ratchet included* / *bit included*.

Tick **show parts I do not own** to see the rest of the catalogue next to what you have,
with a per-row **Fetch** button to pull details for anything you are considering buying.
Parts Hasbro never released are flagged `import`.

### Analysis view

Distribution of the collection currently on screen - yours, or whoever's shelf you opened: attack type of whole beyblades and of every rated part,
product line, spin direction, ratchet heights and contact points, most-used bits and blades,
average stat profile, and catalogue coverage per part kind.

### Bladers view

Lists everyone with an account, with headline numbers for each: how many beyblades and units
they own, how many distinct parts, their most common attack type, and when they last saved.

**Open shelf** loads that person's collection into the normal Collection, Parts and Analysis
views, so you can browse their shelf with the same tools you use on your own. A banner across
the top says whose shelf you are looking at, and everything that writes - the fetch box,
quantity buttons, Remove, Re-fetch, Import, Sync index - disappears until you press
**Back to my shelf**.

Visiting is read-only in both directions: the browser hides the controls, and the server
ignores the requested user on any write and saves to your own shelf regardless. Every
signed-in blader can read every shelf; there is no per-shelf privacy setting.

### Owned, shipping, wishlist

Every beyblade sits in one of three states, and the whole app follows that state:

| Status | Means | Paper |
| --- | --- | --- |
| **Owned** | on the shelf, in hand | plain |
| **Shipping** | bought and on its way | cyan hatching, dotted frame, *In transit* stamp |
| **Wishlist** | wanted, not bought yet | yellow hatching, dashed frame, *Wanted* stamp |

After **Fetch from wiki** the preview offers all three: **Add to collection**, **Add as
shipping**, **Add to wishlist**. If the product is already on your shelf the preview says so,
and adding something you had wished for - as owned or as shipping - moves that entry along
rather than leaving a duplicate behind.

On a card, the **Status** button opens a small popup with *Owned*, *Shipping*, *Wishlist* and
*Delete*: one click to move a beyblade between states, and the only place delete lives, so the
action row stays short. Escape or a click anywhere else closes it. The dates follow the moves -
`wishedAt` when it was wanted, `orderedAt` when it was ordered, `addedAt` when it reached the
shelf.

All three share the grid and sort together - something in the post still lands in the right
place when you sort by weight. The three chips in the toolbar switch each status on or off
independently, so any combination can be shown; turning the last one off brings them all back.

In the Parts view, parts that are only coming or only wished for are listed alongside owned
ones in cyan and yellow rows, and a part you own and have more of on the way shows a
`+N coming` chip next to its count.

Statuses live in the same shelf file (`"status": "shipping"` / `"wish"`), so opening another
blader's shelf shows theirs too, read-only. Everything that describes ownership - the Analysis
view, the footer counter, the parts you can build combos from, the Bladers stats - counts only
what is owned; shipping and wishlist are reported separately.

### Saving, tabs and recovery

Every change is sent as its own small request - "put this beyblade", "remove that one" - and the
server merges it into your shelf under a lock. Each request is a few kilobytes, far below the body
limits shared hosts put on requests, and several open tabs cannot overwrite each other: nobody
uploads a whole, possibly stale, shelf any more. When one tab saves, the others refresh, and every
tab refreshes when you switch back to it. The catalogue is saved the same way, in pieces.

The top bar says **saved**, **saving...** or **not saved (N)**. If the server refuses a change, a
banner says what failed and what the server answered (for example `HTTP 413` or a firewall page).
The change stays queued in this browser - it survives a reload - and **Retry** sends it again.
Closing a tab with unsaved changes asks first.

A tab still running an older version of the app cannot save at all: the server tells it to reload
rather than let it overwrite newer data. If an older version left beyblades in this browser that
never reached the server, the app lists them by name and offers to restore them.

## Accounts

The site is private. On first load it asks you to **claim the site**: the first account you
create becomes the owner, and registration closes automatically behind it. The owner can
reopen it from the **Signup on/off** button in the top bar to let someone else register,
then close it again.

**Every account gets its own shelf.** Your collection is yours; other bladers keep theirs
separately in `data/collections/<userId>.json`.

| File | Contents |
| --- | --- |
| `data/users.json` | usernames and password hashes |
| `data/sessions.json` | live session tokens and failed-login counters |
| `data/collections/<userId>.json` | one shelf per account |

None of them is ever served over the web: they live in the protected data directory.

If you are upgrading from before accounts existed, the old single `data/collection.json` is
adopted as the owner's shelf the first time it is read - moved, not copied, so it happens
exactly once and nothing is duplicated.

**How the passwords are stored.** PBKDF2-SHA256, 120 000 iterations, a random 16-byte salt
per user, compared in constant time - never plaintext, never a bare hash. Sessions are
256-bit random tokens in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` too, whenever the
site is served over HTTPS), valid for 30 days and revoked on logout. Five wrong passwords
park that username for 15 minutes.

The Node and PHP backends implement the identical scheme and file format, so an account
created locally works on the host and vice versa.

Every data endpoint - collection, part index, wiki proxy - returns `401` without a session.
`api/status` stays reachable so you can still check a deployment, but it withholds server
paths and activity counts until you sign in.

**Forgot the password?** There is no reset flow. Delete `data/users.json`, reload, and claim
the site again; the collection is untouched.

**This is a front door, not a vault.** It is honest about what it is: no email verification,
no password reset, no 2FA, no audit log. On a public host, layering cPanel Directory Privacy
on top costs nothing and means attackers never reach the app at all.

## Look and feel

A Persona 5 poster crossed with a turn-of-the-century fan page: black ground, halftone dots,
a crimson slash behind everything, and paper cut-outs pinned on top with hard offset shadows.
Nothing is rounded, nothing is blurred, no gradient pretends to be light. Headings are set in
a heavy condensed face and skewed; labels, counts, borders and rules are all left visible
rather than tidied away, and the footer states plainly what was saved, when, and where.

Type colours carry meaning throughout: Attack red, Defense blue, Stamina green, Balance
purple - on badges, on card top-edges, and in every chart.

Each view carries a large original drawing in the background - a beyblade from above on the
collection, an exploded ratchet on the parts list, an impact mark on the analysis. They live
in `public/art/` as hand-written SVG. To use your own picture instead, drop it in that folder
and repoint the matching line near the top of `styles.css`:

```css
.view-collection { --art: url("art/my-poster.jpg"); }
```

Note that Beyblade character art from the wiki or fan sites is copyrighted; the shipped
artwork is original so the site carries nothing that is not yours to publish.

The whole thing uses system fonts (Impact and friends), so there are no web-font requests and
no external dependencies of any kind.

## Being polite to the wiki

Scraping protection is deliberate and layered:

- **Manual only.** Every wiki request comes from a button press. Nothing polls or prefetches.
- **Disk cache.** `data/wiki-cache/` keeps every response forever; a page is downloaded once
  and never again unless you press **Re-fetch** (which sets `fresh=1`).
- **Serialised and spaced.** Requests go one at a time with a minimum 1.1 s gap.
- **Hourly ceiling.** Hard stop at 300 upstream requests per rolling hour.
- **Real User-Agent**, and the official MediaWiki `api.php` rather than page scraping.

A full CX beyblade costs about 7 requests the first time (page lookup, product page, and one
lookup + one page per part). Shared parts are reused from the cache, so the second beyblade
with the same ratchet costs less.

## Deploying to shared hosting (Apache + PHP, no Node)

The app ships with two interchangeable backends that speak the same JSON API:

| Backend | File | Use |
| --- | --- | --- |
| Node | `server.js` | local use, VPS, any host that runs Node |
| PHP | `public/api.php` | Apache/cPanel/CloudLinux shared hosting |

The browser code is identical for both, and the two share the same on-disk format
(including the wiki cache), so you can work locally on Node and upload the result.

### Steps, using `mydomain.com/OMGBBG/` as the example

1. **Create the folder.** In cPanel File Manager, make `public_html/OMGBBG`.

2. **Upload the contents of `public/`** into it — all eight files:

   ```
   index.html  app.js  store.js  wiki.js  parse.js  api.js  styles.css  api.php  .htaccess
   ```

   `.htaccess` is a dotfile: turn on *Show Hidden Files* in File Manager (Settings), or
   enable hidden files in your FTP client, or it will be silently skipped.
   Do **not** upload `server.js`; it is unused here.

3. **Choose where the data lives.** For a subfolder install, pin it explicitly:

   - create a folder outside the web root, e.g. `/home/YOURUSER/omgbb-data`
     (cPanel shows your home path in the right-hand sidebar);
   - edit `api.php` line 30 and uncomment it with your own path:

     ```php
     define('OMGBB_DATA_DIR', '/home/YOURUSER/omgbb-data');
     ```

   Skip this and the app falls back to creating `public_html/data`, which works and is
   protected by a generated `.htaccess`, but sits inside the web root and collides with
   anything else using that path.

4. **Copy your collection** into that folder: `collection.json` (or the whole `collections/`
   folder if you already have accounts), `part-index.json`, and the whole `wiki-cache/`
   folder if you want to keep the already-downloaded pages.

5. **Check it:** open `https://mydomain.com/OMGBBG/api/status`. Expect

   ```json
   {"ok":true,"backend":"php","dataDirWritable":true,"httpClient":"curl"}
   ```

6. **Open the app** at `https://mydomain.com/OMGBBG/` — with the trailing slash.

7. **Claim the site.** The first visit asks you to create the owner account; registration
   closes behind it. See *Accounts* below.

8. **Optionally add a second lock:** cPanel → *Directory Privacy* → select `OMGBBG` → add a
   user. The app has its own sign-in now, but this stops attackers before they reach PHP.

### Requirements on the host

- **PHP 7.0+** (8.x is fine).
- **curl extension** (standard) or `allow_url_fopen`, for the wiki proxy.
- `mod_rewrite` is *preferred* but not required — see the fallback below.
- No Node, no database, no Composer packages.

### If something is wrong

| Symptom | Cause and fix |
| --- | --- |
| `/api/status` returns 404 | `mod_rewrite` is off or `.htaccess` was not uploaded. The app detects this and falls back to `api.php?route=...` on its own, so it still works — but check that `.htaccess` actually made it up. |
| `dataDirWritable: false` | `chmod 755` the data folder, or point `OMGBB_DATA_DIR` somewhere you own. |
| `httpClient: "none"` | Neither curl nor `allow_url_fopen`; ask the host to enable the curl extension. |
| Header shows `browser only` | The page cannot reach the API at all; open `/api/status` directly to see the error. |
| Stuck on the sign-in screen | Check `/api/status` returns `"ok":true`. If you forgot the password, delete `data/users.json` and claim the site again. |
| Signed out on every reload | The session cookie is not coming back - make sure you are using one hostname consistently (not `example.com` one time and `www.example.com` the next). |
| Blank page, console errors about modules | `.js` files served with the wrong MIME type; the shipped `.htaccess` sets it, so confirm it uploaded. |

### Password-protect it

The app now has its own sign-in (see *Accounts*), so this is optional belt-and-braces. Adding
Apache basic auth on top means a stranger never even reaches the PHP: cPanel → **Directory
Privacy** → select the folder → create a user. `public/.htaccess` also carries a commented-out
`AuthType Basic` block if you prefer to wire it by hand.

### Notes

- Both URL shapes work: `api/collection` where `mod_rewrite` is available, and
  `api.php?route=collection` where it is not. The app tries the first, and switches
  permanently to the second the moment it sees a 404.
- HTTPS is fine and preferred; a shared SSL certificate is enough.
- Saves use `POST`, because mod_security on shared hosts often blocks `PUT`.
- The rate limiter is global, not per visitor. It is sized for one person pressing buttons —
  another reason to keep the folder private.
- If the domain root runs something else (WordPress, say), its rewrite rules do not leak into
  this subfolder: the app ships its own `.htaccess` with `RewriteEngine On`.

## Storage

Everything is JSON on disk:

| File | Contents |
| --- | --- |
| `data/collections/<userId>.json` | one shelf per account: beyblades, custom combos and their part records |
| `data/part-index.json` | catalogue of all known parts and Beyblade X products (**Sync index**, about 25 requests) |
| `data/wiki-cache/` | raw cached wiki API responses |
| `data/backups/` | the last 40 versions of each JSON file, written before every save |

Saves are atomic (temp file + rename). **Export** downloads the collection; **Import** reads
one back. If the server is not running, the app falls back to browser `localStorage` and the
header shows `browser only`.

### Shape of a shelf file

```jsonc
{
  "schema": 1,
  "updatedAt": "2026-09-08T00:16:00.000Z",
  "beyblades": [
    {
      "id": "b...",
      "input": "Reaper Rhino C 4-55D CX",   // what you typed
      "displayName": "Reaper Rhino C4-55D", // Hasbro name
      "qty": 1,
      "notes": "",
      "status": "owned",                    // "owned" | "shipping" | "wish"
      "bey": { "type": "Defense", "system": "Custom Line", "weight": 42.5,
               "productCodes": { "hasbro": "G2746", "takaraTomy": "CX-05" },
               "partRefs": { "lockChip": "Rhino", "mainBlade": "Reaper",
                             "assistBlade": "Charge", "ratchet": "4-55", "bit": "Dot" } }
    }
  ],
  "parts": {
    "bit:dot": { "kind": "bit", "name": "Dot", "code": "D", "type": "Defense",
                 "stats": { "attack": 10, "defense": 55, "stamina": 25,
                            "dash": 10, "burst": 30 } }
  },
  "combos": [
    {
      "id": "c...",
      "name": "Buster Dran 4-60DB",       // built from the parts
      "nickname": "The Lawnmower",
      "lead": "blade",                    // the piece that decided the line
      "line": "Basic / Unique Line",
      "partKeys": { "blade": "blade:dranbuster", "ratchet": "ratchet:460",
                    "bit": "bit:diskball" },
      "tags": ["meta", "test"],
      "rating": 4,
      "strengths": "Outlasts attackers.",
      "weaknesses": "Loses to heavy smash."
    }
  ]
}
```

## Layout

```
server.js          Node backend: static files, JSON storage, wiki proxy
public/api.php     PHP backend: the same API for Apache shared hosting
public/.htaccess   Apache routing, data protection, optional password gate
public/index.html
public/app.js      views, rendering, events
public/api.js      backend URL handling (pretty URLs, with api.php fallback)
public/auth.js     sign-in state and the gate screen
public/art/        background drawings (original SVG)
public/store.js    collection state, persistence, aggregation
public/wiki.js     wiki API calls and infobox interpretation
public/parse.js    product-name parsing (pure functions)
public/styles.css
```

Data comes from the Beyblade Wiki and is available under CC BY-SA.
