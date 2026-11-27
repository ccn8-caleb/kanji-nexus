# Kanji Nexus（漢字ネクサス）

An in-browser, zero-backend suite for mapping, analyzing, and drilling Japanese **kanji (漢字)** and **compounds (熟語・語彙)**. It turns a personal vocabulary notebook into a connected graph, which helps you spot shared character patterns, organize word relationships, and reinforce active recall.

Everything runs client-side from static files. There are no accounts, no server, and no build step.

| Page | Purpose |
| :--- | :--- |
| **Map** (`index.html`) | Interactive canvas of kanji and their compounds. It uses progressive disclosure, typed links between words, 3-tier auto-arrange, and an inspector with undo/redo. |
| **Stats & Index** (`stats.html`) | Top kanji hubs, tag and link breakdowns, and a searchable gojūon (あ〜わ) and cluster index. Any entry jumps to the map. |
| **SRS Drill** (`drill.html`) | SM-2 flashcards, Kanji → Reading or Reading → Kanji (homophones are masked as `〇〇`), with tag filters and map context. |

### Maps & Anki import

* **Several maps.** Each map is a separate graph with its own layout and undo history: one for a textbook, one for a JLPT level, one imported from Anki. Switch from the map name next to the logo; **Manage maps…** renames, duplicates, downloads and deletes them.
* **Import Anki decks** from the same menu: `.apkg` / `.colpkg` (Anki 2.0, 2.1 and the newer zstd format) or a “Notes in Plain Text” / CSV / TSV export. The importer guesses the word, reading and meaning fields (you can change them), previews the result, understands furigana syntax (`日本[にほん]`) and kanji decks (on/kun), and can bring your Anki review progress into the drill. Import into a new map or add to the open one. The file is read on your device and never uploaded. The SQLite reader ([sql.js](https://github.com/sql-js/sql.js), MIT) and Zstandard decoder ([fzstd](https://github.com/101arrowz/fzstd), MIT) are vendored in `site/js/import/vendor/` and load only when you import.
* **Example sentences** come along too: each word gets the example from its note (Kaishi, Core and similar decks are recognised), and notes that are only a sentence become examples of the words they contain rather than map nodes.
* **Clean up this map** (map menu) checks a map and suggests fixes you can tick and apply in one undoable step: sentences stored as words, one-kanji words read in katakana, readings that don't fit the spelling, and empty readings/meanings filled from the dictionary.
* **Drill progress is shared by spelling**, so a word in several maps is one card. The drill can run on this map or on all maps.

### Drill sessions

* A drill session (queue, current card, count) is saved after every step and lasts until you finish it or press **Restart**. Leaving the page, reloading or closing the app doesn't lose it; changing the filters starts a new session.
* **View in map** on a card opens the map with a **Back to drill** button that returns to the same card.
* **Restart** starts the session over; **Reset SRS progress** (header) erases your review history.

### Desktop & tablet

* **Header:** search (`/`), one **Add** button for words or kanji (also `N` / `K`), undo/redo, and a **View** menu for display toggles, link mode, fit and auto-arrange. Data, language and theme sit at the right, or under ⋯ on narrower screens.
* **Context menu:** right-click (or long-press on touch) a node to open, edit, link from it, pin/unpin, center it or delete it, or empty space to add a word or kanji right there.
* **Layout:** new words are placed between their kanji and nearby nodes shift aside to make room. **Tidy up** (View menu) re-lays every cluster organically and packs the clusters around the centre, biggest in the middle and small ones filling in around it; pinned nodes (anything you've dragged) never move. The engine is [d3-force](https://d3js.org/d3-force) (ISC), bundled as `site/js/vendor/d3-force.js`.
* **Tablets** (wider than 700px with a touch screen) keep this layout but with touch-sized controls and the read-first inspector.

### On phones

* **Navigation:** a bottom tab bar (Map / Stats / Drill / ⋯). The ⋯ sheet holds Data & sync, language, theme, and **Install app** when the browser offers it.
* **Map:**
  * opens where you left off; on a first visit it opens on the biggest cluster at a zoom where nodes are easy to tap
  * 🔍 opens search with a tappable results list
  * ⚙︎ holds the view toggles, link mode, auto-arrange and redo
  * ＋ adds a word or a kanji
* **Inspector:** tapping a node opens a bottom sheet with a read-first summary, and the map re-centers the node above it. **Edit** (or swiping up) opens the full form; swiping down goes back or closes. Deleting shows an **Undo** snackbar.
* **Adding words:** the form is a bottom sheet that stays above the keyboard, and the keyboard's Next/Done keys move through the fields. The **reading fills itself in** from the kana you typed before converting (こうぞう → 構造 gives こうぞう). This is best effort: it stops as soon as you edit the word by hand, and you can always change it.
* **Drill:** the card fills the screen, rating buttons stay fixed above the tab bar, and filters fold into one line.

### Dictionary

Typing a new word in the add form looks it up in a built-in **JMdict** dictionary (English edition, about 219k entries) and fills in the **meaning**, the **reading** and matching **grammar tags**. Tags come from the part of speech: suru-verb, transitive/intransitive, na-/i-adjective, adverb, usually kana.

* **Your edits win.** A field you've edited yourself is never overwritten.
* **Homographs** (生物: せいぶつ / なまもの) show chips to switch between entries. When the IME reading matches one, that entry is picked automatically.
* **Where it shows:** the meaning is stored in the word's `meaning` field and shown in the inspector, stats index and drill. On the Reading → Kanji side of the drill it's a hint for telling homophones apart. Search covers meanings ("structure" finds 構造).
* **No server involved.** At deploy time CI downloads the latest [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) release and `kanjinexus dict build` splits it into one small file per first character under `site/dict/` (built only, not committed). The app fetches just the file it needs; files you've used keep working offline.
* **Local development:** without `site/dict/` the lookup simply stays quiet. To try it locally, download a `jmdict-eng-*.json.tgz` release, extract it, and run `go run ./tools/kanjinexus dict build <jmdict-eng.json> site/dict`.

Fonts & icons: Latin text uses a subset of [Inter](https://rsms.me/inter/) (SIL Open Font License, `site/fonts/inter-LICENSE.txt`); icons are from [Lucide](https://lucide.dev) (ISC).

Dictionary data: [JMdict](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project), property of the Electronic Dictionary Research and Development Group, used under its [licence](https://www.edrdg.org/edrdg/licence.html) (CC BY-SA 4.0).

### Install & offline

Kanji Nexus is an installable web app (`site/manifest.webmanifest`).
* **Install:** Android and desktop Chrome/Edge offer it from ⋯ → **Install app**. On iOS, use Share → **Add to Home Screen**.
* **Offline:** the service worker (`site/sw.js`) is network-first. Online you always get the latest deploy; offline, every page keeps working. The deploy workflow stamps the worker with the commit hash and the full file list, so one visit caches the whole app and old caches are cleared on update.
* **Sync after offline:** Google Drive sync resumes when you're back online.

---

## Running it

Pages use ES modules and load the starter sample with `fetch`, so they must be served over HTTP. Opening them from `file://` does not work.

```bash
docker compose -f docker-compose.yml up -d    # nginx on http://localhost:8888
# or
python3 -m http.server -d site 8000
```

The `master` branch deploys `site/` to GitHub Pages (`.github/workflows/static.yml`).

---

## Your data

* **First visit:** the app loads the **starter sample** from `site/data/`. The sample shows every link type, grammar tag, and layout tier.
* **Editing:** every change is saved in that browser right away (IndexedDB; one record per map). Undo/redo covers adding, deleting, renaming, linking, dragging, wiping, resetting and imports, per map.
* **The 💾 Data button** is in every page header:
  * **Download / load `.json`:** backups of this map or of all maps. Loading a single-map file asks whether to add it as a new map or replace the open one. Old exports in the `primaryNodes` format are migrated automatically.
  * **Import Anki deck** (see above).
  * **Sync with Google Drive** (when configured, see below): keeps your data in a hidden app folder in your own Google Drive and syncs automatically between devices.
  * **Transfer link:** the open map is gzipped into a URL `#fragment`. Open the link on another device to import it. The fragment is never sent to any server.
  * **Share file:** sends a backup to the phone's share sheet (AirDrop, Files, Drive, …) where the browser supports it.
  * **Reset to sample** or **Erase this map**. Both can be undone in the current tab.
  * **Edit raw JSON** directly.

Data from earlier versions moves into a map called **マイマップ** on first load: 0.6.x data from `localStorage` (`kanji_nexus_data_v2`), and older `kanji_nexus_data_v1` data, whose SRS progress is carried over to the new node IDs. The old keys are left in place as a backup.

### Google Drive sync

* **Connecting:** one click, then Google's sign-in popup (consent the first time only). Every map goes into Drive's hidden *app data* folder as its own file (`kanji-nexus-map-<id>.json`), listed in `kanji-nexus-index.json`; only changed maps upload. New maps, renames and deletions carry across devices. A new device's untouched sample map isn't uploaded; it makes way for the maps already in Drive. (The single `kanji-nexus.json` from 0.6.0–0.6.2 is adopted as the file of your migrated map.) It is invisible in the Drive UI, other apps can't read it, and the app can't see any of your other files (scope `drive.appdata`).
* **While connected:** edits sync a few seconds after you make them, and changes from other devices are picked up when you come back to the tab.
* **Sign-in expiry:** Google sign-ins expire after about an hour and can't renew without a click. The 💾 button then shows **☁!** and **Sync now** signs in again.
* **Conflicts are decided by content, per map.** If only one side changed, it wins automatically. If both changed, or a new device's data differs from Drive's, you choose which copy to keep. Taking Drive's copy can be undone with Ctrl+Z on the map.
* **Drill progress** syncs too (`kanji-nexus-srs.json`), merged card by card: the later review of each card wins, so it never asks which copy to keep. A progress reset carries across devices.

**One-time setup (site owner).** Google Drive sync stays hidden until a client ID is configured.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen: set the app name and support email, add the scope `https://www.googleapis.com/auth/drive.appdata`, and publish the app. While it is in *Testing*, only listed test users can sign in. `drive.appdata` is a non-sensitive scope, so only Google's basic app verification applies.
3. Create an **OAuth client ID** of type *Web application*. Under **Authorized JavaScript origins**, list every origin you serve from, e.g. `https://kanjinexus.concatn8.com` and `http://localhost:8000`.
4. Put the client ID in `site/js/sync/config.js` and deploy. Client IDs are public by design.

Google sign-in only works on HTTPS (or `localhost`). On a plain-`http://` page the panel offers to reopen the site over HTTPS, and you should enable **Enforce HTTPS** in the repo's Pages settings.

---

## Data format

The starter sample lives in four files in `site/data/`. Backups and transfer links use the same shape, bundled into one object with `"schema": 2` (plus the map's `"name"`). **Download all maps** wraps them as `{ "kind": "kanji-nexus-workspace", "version": 1, "maps": [ { "name", …bundle } ] }`. Each file has **one record per line**, sorted, so pruning by hand is a matter of deleting lines.

```jsonc
// kanji.json — keyed by character
{ "構": {"on":["コウ"],"kun":["かま.える","かま.う"]} }

// words.json — keyed by written form, sorted by reading
{ "構造": {"reading":"こうぞう","meaning":"structure; construction; …","notes":"物事の組み立て・仕組み",
           "examples":[{"ja":"建物の構造を調べる。","reading":"たてもののこうぞうをしらべる。","en":"Examine the building's structure."}]},
  "構成": {"reading":"こうせい","tags":["suru"]} }

// links.json — undirected [word, word, type]
[ ["構成","構造","synonym"] ]

// layout.json — map positions only
{ "kanji": { "構": [80,-620] }, "words": { "構造": [80,-740] } }
```

* **Parent kanji are never stored.** A word attaches to every registered kanji in its spelling, with `々` resolving to the preceding kanji (人々 → 人). Delete a kanji and its words stay; add one and matching words attach to it.
* **Optional fields** (`meaning`, `notes`, `tags`, `examples`, `color`) are omitted when empty or default. An example needs `ja`; `reading` (kana) and `en` are optional.
* **Homographs** use a `#` suffix on the key: `"生物#なまもの"` displays as 生物.
* **Layout is disposable.** Entries missing from `layout.json` are placed automatically next to their kanji. Delete the file's contents (`{"kanji":{},"words":{}}`) and the map tidies itself. A position with a third value, `[x, y, 1]`, is **pinned**: automatic layout never moves it (dragging a node in the app pins it).
* Tags: `suru`, `intransitive`, `transitive`, `na-adj`, `i-adj`, `adverb`, `kana`. Link types: `related`, `antonym`, `synonym`, `derivative`, `lookalike`. Both lists are defined in `site/js/core/constants.js`.

### Maintenance tool (Go)

```bash
go run ./tools/kanjinexus lint                    # unknown tags/types, dangling links, missing kanji, readings, formatting
go run ./tools/kanjinexus fmt [-check]            # rewrite site/data in canonical order and layout
go run ./tools/kanjinexus prune                   # drop dangling links and stale layout entries
go run ./tools/kanjinexus import backup.json      # replace site/data with an app backup
go run ./tools/kanjinexus dict build <jmdict-eng.json> site/dict   # dictionary files (CI does this)
go run ./tools/kanjinexus dict fill  <jmdict-eng.json>             # add missing meanings to site/data
```

To update the starter sample from the app: edit it in the browser, then **💾 Data → Download .json**. Run `import` on the file, then `lint`, and commit. The Go formatter and the app's serializer produce identical bytes, so diffs only show real changes.

---

## Versions & deploys

* **Branches:** work happens on feature branches merged into **`development`**, which collects the next release. Pushes and PRs to `development` run the checks (lint, formatting, changelog entry) but never deploy. A release is a PR (or fast-forward) from `development` into **`master`**; every push to `master` builds and deploys to GitHub Pages.

* **App version:** semver, in `site/js/core/version.js`. To release, bump `APP_VERSION` and add a `## [x.y.z]` entry to [CHANGELOG.md](CHANGELOG.md). CI refuses to deploy a version that has no changelog entry.
* **Build id:** at deploy, `tools/stamp-deploy.sh` stamps the commit hash and date. The app shows both at the bottom of the 💾 Data panel and the ⋯ sheet (e.g. `v0.5.0 · build e9a6960 · 2026-11-24`). The first time a device opens a new version, it shows an "Updated to vX.Y.Z" notice linking to the changelog.
* **What's live:** `curl -s https://kanjinexus.concatn8.com/ | grep app-version` prints e.g. `0.5.0+e9a6960c1b2d`. In the browser console, `KANJI_NEXUS_VERSION` shows the same.
* **Cache-proof deploys:** the same script appends `?v=<build>` to every CSS/JS URL and import, so Cloudflare and browser caches can never mix files from two deploys. It also writes the offline precache list into `sw.js`. It only runs on CI's copy of the site; locally everything stays unversioned (`dev build`).

---

## Code layout

```
site/
  index.html  stats.html  drill.html     markup only; each loads one module from js/pages/
  css/base.css                           theme variables + shared components
  css/{map,stats,drill}.css              page-specific styles
  data/*.json                            starter sample
  js/core/
    constants.js   tags, link types, palette, storage keys, dictionary URLs
    schema.js      normalize, canonical text format, v1 → v2 migration
    graph.js       derived read-only index (parents, children, links, clusters)
    ops.js         every data mutation (add/rename/delete/link/rescan, reading hints)
    store.js       owns the maps and the open doc: load/migrate, undo/redo, persist, import/reset/wipe, cross-tab sync
    db.js          IndexedDB wrapper (maps + workspace), in-memory fallback
    maps-ui.js     map switcher, Manage maps dialog, downloads
    examples.js    example sentences: normalise, highlight, attach to the words a sentence contains
    srs.js         SM-2 scheduling and progress storage
    prefs.js       language + theme (shared across pages and tabs)
    ui.js          toast/snackbar, modals & bottom sheets, popover/context menus, layout modes, tooltips
    icons.js       the app's icon set (Lucide, ISC) as inline SVG
    kana.js        reading fields: romaji → kana, hiragana/katakana, double space → ・
    ime.js         reading capture from IME composition, Enter-to-next-field
    pwa.js         service-worker registration, install prompt
    hub.js         page shell: nav, header controls, Data panel, deep links
  js/pages/        stats.js, drill.js, map/{main,canvas,inspector,layout}.js
  js/sync/         transfer/sync plugins (see below); config.js holds the Google client ID
  js/cleanup/      Clean up this map: scan.js (pure: find issues, apply fixes), ui.js (dialog)
  js/import/       Anki import: anki-ui.js (dialog), anki-parse.js (pure: fields, furigana,
                   scheduling → SRS), anki-worker.js (zip + zstd + SQLite off the main thread),
                   vendor/ (sql.js, fzstd; cached on first use, not precached)
tools/kanjinexus/  Go CLI for site/data
tools/stamp-deploy.sh  deploy-time versioning (asset URLs, build stamp, service worker)
```

Some rules the code follows:

* Pages read data from `store.graph` and change it only through `store.edit((doc) => ops.…)`. That one path gives undo, persistence, and re-rendering on every page and in other tabs.
* Each page starts with `const { store, focusId } = await initPage('<id>')`.
* Pages link to each other with `?focus=<node id>`. Node IDs are `k:<kanji>` and `w:<word key>`.

### Adding a page

1. Add `{ id, ja, en, tipJa, tipEn, file, icon }` to `APPS` in `js/core/hub.js`.
2. Create the HTML with the standard header slots (`#nexus-hub-slot` for navigation, `#nexus-hub-controls` for Data/language/theme), and load `css/base.css` and your module.

### Adding a sync or transfer method

Plugins live in `js/sync/` and are listed in `js/sync/index.js`. A plugin exports `{ id, install(ctx) }`. It adds buttons to the Data panel with `ctx.registerDataAction(...)` and works only with whole snapshots: the open map (`ctx.store.exportText()` / `ctx.store.importData()`) or any map by id (`store.maps`, `store.getMapDoc(id)`, `store.putMapDoc(id, doc)`). Removing a plugin from the list removes the feature, with no other code changes.

### Storage keys

Maps live in **IndexedDB** (database `kanji-nexus`): store `maps` (one record per map: id, name, doc, timestamps) and store `meta` (`workspace`: map order, the open map, deletions for sync). Everything else is in `localStorage`:

| Key | Contents |
| --- | --- |
| `kanji_nexus_srs_v1` | drill progress by node ID (shared by all maps) |
| `kanji_nexus_srs_meta` | `{ resetAt }`: when progress was last reset (sync drops older reviews) |
| `kanji_nexus_drill_scope` | drill on this map or all maps |
| `kanji_nexus_drill_session` | the saved drill session (filters, queue of node IDs, count, flipped) |
| `kanji_nexus_return_to` | *sessionStorage*: this tab's map was opened from the drill (shows **Back to drill**) |
| `kanji_nexus_lang` / `kanji_nexus_theme` | interface preferences |
| `kanji_nexus_map_view` | map toggles (reveal all, readings, auto-link, auto-create) |
| `kanji_nexus_map_camera:<map id>` | last position and zoom of each map on this device |
| `kanji_nexus_gdrive` | Drive sync state (enabled, index file, per map and for drill progress: file id, last synced version and content hash) |
| `kanji_nexus_gdrive_token` | current Google access token (expires in about an hour) |
| `kanji_nexus_unsaved` | a map whose save was still in progress when a page closed; replayed into IndexedDB on the next load, then removed |
| `kanji_nexus_data_v2` | 0.6.0–0.6.2 data; read once to migrate into a map and never written |
| `kanji_nexus_data_v1` | older data; read once for migration and never written |
