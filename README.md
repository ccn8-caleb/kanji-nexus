# Kanji Nexus (漢字ネットワーク)

An in-browser, zero-backend suite for mapping, analyzing, and drilling Japanese **kanji (漢字)** and **compounds (熟語・語彙)**. Built with Gemini, Kanji Nexus turns a personal vocabulary notebook into a connected graph—helping you spot shared character patterns, organize word relationships, and reinforce active recall.

---

## Suite Architecture

All application files live inside the `site/` directory and share a single hotbar and data-bridge script (`nexus-hub.js`). Every mini-app reads and updates the same underlying JSON dataset without requiring backend databases or build steps.

| File | Module | Purpose |
| :--- | :--- | :--- |
| **`site/kanji_nexus.html`** | **Network Map (`漢字ネットワーク`)** | Interactive canvas for mapping primary kanji and multi-parent compounds with progressive disclosure, auto-linking, and cluster auto-layout. |
| **`site/kanji_stats.html`** | **Stats & Index (`統計・索引`)** | Analytics dashboard ranking high-connection kanji hubs, grammar/link distributions, and a searchable Gojūon (`あ〜わ`) & cluster index. |
| **`site/kanji_drill.html`** | **SRS Drill (`復習ドリル`)** | Spaced-repetition (SM-2) flashcard trainer supporting `Kanji → Reading` and `Reading → Kanji` recall with tag filters and map context. |
| **`site/nexus-hub.js`** | **Shared Hotbar & Bridge** | Injects the navigation hotbar across all pages and synchronizes data, language (`日本語 / EN`), theme, and deep-link focus targets. |

---

## Key Features

### 1. Progressive-Disclosure Network Map (`site/kanji_nexus.html`)
* **Focus Mode (`集中表示`) vs. Reveal All (`全体表示`):** Keeps large graphs readable by showing only top-level kanji until a node is selected, revealing its connected compounds and related links on demand.
* **Automatic Bidirectional Kanji Linking (`自動リンク`):** Automatically extracts constituent kanji (including iteration marks like `々`), attaches compounds to all matching primary kanji, and optionally scaffolds unregistered primary kanji (`未登録漢字自動作成`) beside existing siblings.
* **3-Tier Cluster Auto-Arrange (`自動整列`):** Organizes disconnected graph components into multi-kanji hubs at the top, 2-kanji compound pairs in the middle, and single-kanji islands at the bottom.
* **Typed Lateral Compound Links:** Connects compounds directly via `対義語` (Antonym), `類義語` (Synonym), `派生語` (Derivative), `類形語` (Lookalike), and `関連語` (Related), with automatic morphological derivative detection.
* **Grammar Tags & Reading Hints:** Tag vocabulary with `する動`, `自動`, `他動`, `な形`, `い形`, `副`, or `かな表記`, filter the map by tag, and infer `音読み` / `訓読み` suggestions from attached compounds.
* **Study & Editing Utilities:** Includes 50-step Undo/Redo (`Ctrl+Z` / `Ctrl+Y`), one-click lookups in Japanese dictionaries (漢字ペディア, 漢字辞典オンライン, Weblio, コトバンク, Jisho), light/dark themes, and bilingual `日本語 / EN` hover and mobile long-press tooltips.

### 2. Statistics & Gojūon Index (`site/kanji_stats.html`)
* **Hub Rankings:** Visualizes which primary kanji connect to the highest number of compounds in your dataset.
* **Tag & Relationship Breakdown:** Summarizes vocabulary distribution across grammar tags and lateral link types.
* **Searchable Directory:** Filter entries by view (`All`, `Primary Kanji`, `Compounds`, `Clusters`), kana row (`あ`–`わ`), grammar tag, or search query, and jump directly to any node on the map (`Map ↗`).

### 3. Spaced-Repetition Flashcard Drill (`site/kanji_drill.html`)
* **Automatic Deck Sync:** Pulls newly added kanji and compounds from your map automatically without altering your core JSON backup.
* **Bidirectional Active Recall:** Switch between **Kanji → Reading** and **Reading → Kanji** (with character masks `〇〇` and grammar/note hints for distinguishing homophones).
* **SM-2 Scheduling:** Tracks review intervals locally (`Again`, `Hard`, `Good`, `Easy`) while displaying constituent kanji, linked antonyms/synonyms, and dictionary links on card flip.

---

## Getting Started

### Option 1: Host with Docker & Nginx (`compose.yml`)
The repository includes a `compose.yml` configured to spin up an Nginx container serving the `site/` directory:

```bash
docker compose up -d
```

Once running, open `http://localhost:<port>/kanji_nexus.html` in your browser (check `compose.yml` for the mapped host port). Serving over HTTP ensures all pages share a single origin for real-time multi-tab `localStorage` updates.

### Option 2: Use Directly on Desktop or Mobile (No Server Required)

The `site/` folder is completely self-contained and works directly from local storage on a computer or smartphone without running a web server:

1. Copy the `site/` directory to your computer or phone.
2. Open `site/kanji_nexus.html` directly in any modern browser (`file://`).
3. Use the top hotbar to switch between **Map**, **Stats & Index**, and **SRS Drill**—your data carries over automatically between pages.

---

## Portable JSON Data Schema

All map data is stored under `primaryNodes` and can be exported or imported anytime via **JSON入出力** for backups, sharing, or external scripts:

```json
{
  "primaryNodes": [
    {
      "id": "p-kou",
      "label": "構",
      "onyomi": "コウ",
      "kunyomi": "かま.える",
      "color": "#3b82f6",
      "x": -240,
      "y": -120,
      "notes": "",
      "connections": [
        {
          "id": "s-kouzou",
          "label": "構造",
          "reading": "こうぞう",
          "color": "#10b981",
          "x": -80,
          "y": -120,
          "linksTo": [{ "targetId": "s-kousei", "type": "synonym" }],
          "tags": [],
          "notes": ""
        }
      ]
    },
    {
      "id": "p-zou",
      "label": "造",
      "onyomi": "ゾウ",
      "kunyomi": "つく.る",
      "color": "#3b82f6",
      "x": 80,
      "y": -120,
      "notes": "",
      "connections": [
        { "refId": "s-kouzou" }
      ]
    }
  ]
}

```

---

## Adding New Mini-Apps & Cross-App Data Handoff

Kanji Nexus is designed so you can add new tools that operate on your vocabulary JSON without editing `kanji_nexus.html`, `kanji_stats.html`, or `kanji_drill.html`.

### 1. Registering a New Mini-App

1. **Create your HTML file inside `site/**` (for example, `site/kanji_table.html`) and load `nexus-hub.js` in `<head>`:
```html
<script src="nexus-hub.js"></script>

```


2. **Provide a hotbar mount point (optional):**
* Place `<div id="nexus-hub-slot"></div>` inside your header to render the hub navigation pills inline.
* If omitted, `nexus-hub.js` automatically mounts a floating navigation dock at the bottom center of the viewport.


3. **Register the app in `site/nexus-hub.js`:** Add one entry to the `NEXUS_APPS` array at the top of `nexus-hub.js`. Every existing page will display the new navigation tab automatically:
```javascript
const NEXUS_APPS = [
  { id: 'map',   ja: 'マップ',     en: 'Map',           file: 'kanji_nexus.html', icon: '🕸️' },
  { id: 'stats', ja: '統計・索引', en: 'Stats & Index', file: 'kanji_stats.html', icon: '📊' },
  { id: 'drill', ja: '復習ドリル', en: 'SRS Drill',     file: 'kanji_drill.html', icon: '🎴' },
  { id: 'table', ja: '一覧編集',   en: 'Batch Editor',  file: 'kanji_table.html', icon: '📝' }
];

```



### 2. `NexusHub` JavaScript API

Any page that loads `nexus-hub.js` has access to the global `window.NexusHub` helper:

| Method | Description |
| --- | --- |
| `NexusHub.getData()` | Returns the latest `{ primaryNodes: [...] }` object (reconciling `window.name` and `localStorage`). |
| `NexusHub.saveData(data)` | Persists updated JSON to `localStorage` and updates the `window.name` bridge payload. |
| `NexusHub.openInMap(nodeId)` | Navigates to `kanji_nexus.html` and smoothly centers/selects the target kanji or compound. |
| `NexusHub.navigate(appId, opts)` | Switches to another registered mini-app (supports `{ focusId }` for deep-linking). |
| `NexusHub.onBeforeNavigate(fn)` | Registers a callback to flush unsaved edits right before the user switches apps. |
| `NexusHub.onDataChange(fn)` | Subscribes to live dataset updates across tabs or components. |
| `NexusHub.getLang()` / `getTheme()` | Reads the shared interface language (`'ja'` / `'en'`) and theme (`'light'` / `'dark'`). |

### 3. How Data Carries Over Between Apps

Because Kanji Nexus runs both over HTTP (Nginx) and directly from local files (`file://` on desktop or mobile), `nexus-hub.js` uses a layered handoff strategy so state is never lost during navigation:

1. **Shared `localStorage` Keys:**
* `kanji_nexus_data_v1` stores the canonical `{ primaryNodes }` JSON graph.
* `kanji_nexus_lang` and `kanji_nexus_theme` synchronize language and dark/light mode across all tools.
* Mini-apps with tool-specific metadata (such as `kanji_nexus_srs_v1` in `kanji_drill.html`) store their own progress under separate keys so your core vocabulary JSON stays clean and portable.


2. **`window.name` Transport Bridge (`__kanjiNexusBridge`):**
* Some mobile and desktop browsers isolate `localStorage` per filename when HTML files are opened directly via `file://`.
* Whenever you click a link in the hotbar or call `NexusHub.openInMap(id)`, `nexus-hub.js` runs any registered `onBeforeNavigate` hook, serializes the full JSON dataset, active theme/language, and target `focusId` into `window.name`, and navigates. On load, the destination page absorbs the `window.name` payload into its own `localStorage` immediately.


3. **Deep-Link Focus Resolution:**
* Jumping from `kanji_stats.html` or `kanji_drill.html` back to the Map passes the target node ID via `?focus=<id>`, `window.name`, and `kanji_nexus_focus_id`. `kanji_nexus.html` consumes the ID on startup, clears any active search/tag filters, reveals the node's connections, and centers the camera on it—then clears the transient focus marker so page reloads behave normally.
