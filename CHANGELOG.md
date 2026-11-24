# Changelog

Versions follow [semver](https://semver.org/). The version lives in
`site/js/core/version.js`; every release needs an entry here (CI checks it). Each
deploy also carries a build id (commit hash), shown next to the version in the app.

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
