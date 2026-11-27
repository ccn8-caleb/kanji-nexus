# Changelog

Versions follow [semver](https://semver.org/). The version lives in
`site/js/core/version.js`; every release needs an entry here (CI checks it). Each
deploy also carries a build id (commit hash), shown next to the version in the app.

**Numbering (from 0.6.0):** every release bumps the patch number (0.6.1, 0.6.2, …,
0.6.15 is fine). The minor number only moves for a milestone called out on purpose.

## [0.6.5] — 2026-11-27 — Example sentences & map clean-up

### Added
- **Example sentences on words** (`examples: [{ ja, reading?, en? }]` in `words.json`).
  The inspector lists them with the word highlighted and lets you add, edit and delete
  them; the drill shows up to two on the back of the card.
- **Anki import reads example sentences.** Sentence fields (Kaishi: Sentence / Sentence
  Furigana / Sentence Meaning; Core: Expression / Sentence-Kana / Sentence-English) are
  guessed like the other fields and become each word's example. **Sentence-only notes**
  become examples of the words they contain instead of map nodes; sentences that match
  no word are skipped and counted.
- **Clean up this map** (map menu): checks the open map and lists suggestions with
  checkboxes, applied together as one undoable step:
  - sentences stored as words → examples of the words they contain (node removed)
  - one kanji read in katakana (借 シャク) → that kanji's on'yomi
  - readings that don't fit the spelling → the part that fits, or the dictionary's
  - empty readings, meanings and tags → from the dictionary (pick the entry where
    there are several, e.g. 生 なま / せい)
  - kanji without readings → guessed from their words (opt-in)
- **Fill from dictionary** in the inspector when a word's reading or meaning is empty.

### Fixed
- Edits made just before leaving a page could be lost (the IndexedDB write didn't
  finish in time; about 1 in 6 when switching pages straight after an edit). An unsaved
  map is now also written synchronously on page exit and recovered on the next load.
- Anki import: furigana without a space before it (`は学生[がくせい]`) no longer drops
  the kana in front of the kanji from the reading; a reading column with a few
  sentence readings in it is still recognised.

## [0.6.4] — 2026-11-27 — Drill sessions & progress sync

### Added
- **Drill sessions are saved.** The queue, the current card (flipped or not) and the
  count so far survive leaving the page: “View in map”, switching tabs, reloading or
  the app being closed. The session lasts until it is finished or restarted; changing
  the filters starts a new one. Vocabulary edits update the session instead of
  restarting it (deleted words drop out, new ones join at the end).
- **Back to drill:** a map opened from a drill card shows a “ドリルに戻る · 2 / 45” button
  that returns to the same card. It stays while you explore the map (reloads
  included) and goes away once you open another page.
- **Restart** (next to the session progress) starts the session over without touching
  your review history — unlike **Reset SRS progress**, which erases it.
- **Drill progress syncs with Google Drive** (`kanji-nexus-srs.json`), merged card by
  card: the later review of a card wins, so two devices never conflict. Resetting
  progress carries across devices too, and older reviews can't come back.

### Changed
- Review records now carry the time of the last review (`at`); imported Anki progress
  counts as reviewed at import time.
- **Tidy up keeps the map round and central.** Clusters are packed around the middle,
  biggest first, each at the nearest free spot on an outward spiral, instead of in rows
  (where hundreds of small clusters ended up far from everything). Small clusters sit
  closer together, big ones get more room. On a 2,300-node Anki map the farthest node
  is about half as far from the centre as before.

### Fixed
- Anki import: a reading field that holds more than the reading (a conjugation table,
  several forms, HTML tables) no longer becomes one long run of kana. Readings must fit
  the spelling (each kanji 1–6 kana, written kana as written); the first one that fits
  is used, otherwise the reading is left for the dictionary to fill.
- Anki import: a single kanji with a katakana reading (借 シャク) is treated as that
  kanji's on'yomi, not as a separate one-character word.

## [0.6.3] — 2026-11-27 — Maps & Anki import

### Added
- **Several maps.** Each map is its own graph (words, kanji, links, layout, undo
  history). Switch from the map name next to the logo; **Manage maps** renames,
  duplicates, downloads and deletes them. Each map remembers its own camera.
- **Import Anki decks** (switcher menu, Manage maps, or the Data panel):
  `.apkg` / `.colpkg` from any Anki version (2.0, 2.1, and the newer zstd format),
  and “Notes in Plain Text” / CSV / TSV exports. The importer guesses which field is
  the word, reading and meaning (Kaishi, Core 2k/6k and common layouts work out of
  the box), shows a preview, and handles furigana syntax (`日本[にほん]`), HTML,
  homographs (人 ひと / じん become two words) and kanji decks (on/kun readings).
  Import as a new map (laid out before it opens) or add to the open map (undoable).
  Optionally carries Anki review progress into the drill and fills empty readings and
  meanings from the dictionary. The file is read on the device; nothing is uploaded.
- **Drill scope:** drill this map or all maps. A word that appears in several maps is
  one card (progress is shared by spelling).
- Backups and transfer links carry the map name; loading one asks whether to add it as
  a new map or replace the open one. **Download all maps** saves every map in one file.

### Changed
- Maps are stored in IndexedDB instead of localStorage (room for large decks). Existing
  data moves into a map called “マイマップ” on first load; the old localStorage copy is
  left in place as a backup.
- Google Drive sync now keeps every map: one file per map plus a small index, so only
  changed maps upload. Renames and deletions carry across devices. The single file
  from 0.6.0–0.6.2 is adopted as your migrated map's file, not duplicated. A new
  device's untouched sample map gives way to the maps already in Drive.

### Fixed
- Opening a transfer link no longer holds up the page until its dialog is answered.

## [0.6.2] — 2026-11-24 — Map layout

### Changed
- New layout engine (force-directed, d3-force): links act as springs, nodes repel,
  and collisions use each node's real size, so nothing overlaps or crowds.
- Adding words no longer crams them into the nearest gap. A new word starts between
  its kanji (or on the free, outward side of a single kanji) and its nearest
  neighbours shift aside to make room, with a short animation; the rest of the map
  stays put. Back-to-back adds around one kanji spread evenly around it.
- **Tidy up** (replaces 自動整列): each connected cluster gets an organic layout with
  its busiest kanji in the middle, untangled to minimise crossing lines, and the
  clusters are packed into rows with even gaps — compact, not spread out. Large maps
  (400+ nodes) lay out in a background thread so the page never freezes. Undoable.
- The inspector's "Center between parents" is now **Tidy around this**.
- The starter sample was re-laid-out with Tidy up.

### Added
- **Pins**: dragging a node pins it (small pin badge), and automatic layout never moves
  pinned nodes. Pin/unpin from the right-click / long-press menu; "Unpin all" in the
  View menu. "Add here" pins the new node where you clicked. In `layout.json` a pinned
  position is `[x, y, 1]`.

## [0.6.1] — 2026-11-24 — Polish

### Changed
- New Japanese name: **漢字ネクサス** (was 漢字ネットワーク), shown in every page header,
  the window title and the installed app.
- New app icon: a kanji practice grid (田字格) at the hub of a colourful node network,
  drawn as pure shapes so it renders the same everywhere, from the browser tab to the
  home screen.
- One font system: Latin letters and numbers come from a bundled Inter (identical on
  every device), Japanese from the platform's best Japanese font; all buttons and
  chips inherit it, and numbers use equal-width digits.
- One icon set (Lucide) replaces emoji and text symbols throughout.
- Desktop header streamlined: a prominent search field (/), one **Add** button
  (word or kanji, also N / K), undo/redo, and a single **View** menu for display
  toggles, link mode, fit and auto-arrange.
- Tablets (iPad etc.) get the desktop layout with touch-sized controls and the
  read-first inspector; the phone layout now starts below 700px wide.

### Added
- Context menu on the map: right-click, or long-press on touch, a node (open, edit,
  link from here, center, delete) or empty space (add word/kanji here, fit,
  auto-arrange).
- Back-to-back entry: Enter saves the word or kanji and clears the form for the next
  one (waiting a moment for the dictionary if needed); a running list shows what you
  added; Done / Esc closes and shows the last one.
- Reading fields format as you type: hiragana for readings and kun'yomi, katakana for
  on'yomi; romaji converts live without an IME (kouzou → こうぞう); a double space
  inserts ・ between readings.

## [0.6.0] — 2026-11-24 — Dictionary

### Added
- Built-in dictionary (JMdict, English): typing a new word fills in its **meaning**,
  **reading** and matching **grammar tags** (suru-verb, transitive/intransitive,
  na-/i-adjective, adverb, usually kana). Fields you edit yourself are never
  overwritten; words with several entries (生物: せいぶつ / なまもの) offer chips to
  switch, and the IME reading picks the right one automatically.
- Words have a new optional `meaning` field, shown in the inspector, stats index and
  drill (on the answer side, and as a hint when drilling Reading → Kanji), and
  searchable (e.g. "structure" finds 構造).
- The starter sample now has meanings.
- `kanjinexus dict build` (deploy) and `kanjinexus dict fill` (fill missing meanings
  in `site/data`).

Dictionary data: JMdict © EDRDG, CC BY-SA 4.0.

## [0.5.0] — 2026-11-24

### Added
- App version and build id in the 💾 Data panel and the ⋯ sheet, plus an
  `app-version` meta tag on every page (`curl -s <site> | grep app-version`).
- An "Updated to vX.Y.Z" notice with a link to this changelog the first time a
  device opens a new version.

### Fixed
- Updates no longer arrive half-applied (new HTML with old CSS/JS from the
  Cloudflare or browser cache). Every deploy now references its CSS/JS with
  `?v=<build>` URLs, and pages always revalidate with the server.

## [0.4.0] — 2026-11-24 — Mobile & installable app (#3)

### Added
- Phone layout: bottom tab bar, ⋯ sheet, bottom-sheet forms that stay above the
  keyboard, map search with results, tools sheet, ＋ button, read-first inspector
  sheet with swipe gestures, Undo snackbar, readable start / remembered map position.
- Reading filled in automatically from IME input (こうぞう → 構造).
- Drill: compact stats, folded filters, answer buttons fixed in the thumb zone.
- Installable PWA with offline support (manifest, icons, service worker).

### Fixed
- On phones the map toolbar was unreachable, page tabs overflowed, drill rating
  buttons were off-screen, and iOS zoomed into every text field.

## [0.3.0] — 2026-11-24 — Google Drive sync (#2)

### Added
- Optional sync of your data through a hidden app folder in your own Google Drive,
  with automatic sync, content-based conflict handling, and a status badge.

## [0.2.0] — 2026-11-24 — Core rework (#1)

### Changed
- Hand-editable data model (`site/data/*.json`), shared core modules, one module per
  page, shared stylesheet; old data and drill progress migrate automatically.
- Pages renamed: `kanji_stats.html` → `stats.html`, `kanji_drill.html` → `drill.html`.

### Added
- 💾 Data panel (backup files, transfer links, reset/erase), starter sample covering
  every feature, `kanjinexus` Go tool, CI lint before deploy.

## [0.1.0] — 2026-11-21

- Initial prototype: kanji map, stats & index, SRS drill.
