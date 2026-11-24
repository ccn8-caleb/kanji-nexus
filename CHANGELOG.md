# Changelog

Versions follow [semver](https://semver.org/). The version lives in
`site/js/core/version.js`; every release needs an entry here (CI checks it). Each
deploy also carries a build id (commit hash), shown next to the version in the app.

**Numbering (from 0.6.0):** every release bumps the patch number (0.6.1, 0.6.2, …,
0.6.15 is fine). The minor number only moves for a milestone called out on purpose.

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
