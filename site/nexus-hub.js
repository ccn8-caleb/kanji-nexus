/**
 * nexus-hub.js — Shared Hotbar Loader & Cross-App Data Bridge for KanjiNexus
 *
 * To register a new mini-app in the future, simply add an entry to NEXUS_APPS below.
 * Existing HTML pages do not need to be edited.
 */
(function (global) {
  'use strict';

  // =========================================================================
  // 1. SINGLE SOURCE OF TRUTH FOR ALL MINI-APPS
  // =========================================================================
  const NEXUS_APPS = [
    {
      id: 'map',
      ja: 'マップ',
      en: 'Map',
      descJa: '漢字・熟語ネットワーク図',
      descEn: 'Kanji & Compound Network Map',
      file: 'index.html',
      icon: '🕸️'
    },
    {
      id: 'stats',
      ja: '統計・索引',
      en: 'Stats & Index',
      descJa: '統計ダッシュボードと五十音索引',
      descEn: 'Statistics & Kana Index',
      file: 'kanji_stats.html',
      icon: '📊'
    },
    {
      id: 'drill',
      ja: '復習ドリル',
      en: 'SRS Drill',
      descJa: '間隔反復フラッシュカード練習',
      descEn: 'Spaced Repetition Flashcard Drill',
      file: 'kanji_drill.html',
      icon: '🎴'
    }
  ];

  // =========================================================================
  // 2. SHARED STORAGE KEYS & STATE
  // =========================================================================
  const STORAGE_KEYS = {
    DATA: 'kanji_nexus_data_v1',
    FOCUS_ID: 'kanji_nexus_focus_id',
    LANG: 'kanji_nexus_lang',
    THEME: 'kanji_nexus_theme'
  };

  let beforeNavigateCallback = null;
  const dataChangeListeners = new Set();

  function getCurrentFileName() {
    try {
      const path = global.location.pathname || '';
      const name = path.split('/').pop();
      return name || 'kanji_nexus.html';
    } catch (_) {
      return 'kanji_nexus.html';
    }
  }

  function resolveApp(idOrFile) {
    if (!idOrFile) return NEXUS_APPS[0];
    return (
      NEXUS_APPS.find((a) => a.id === idOrFile || a.file === idOrFile) ||
      NEXUS_APPS[0]
    );
  }

  function getLang() {
    try {
      const saved = global.localStorage.getItem(STORAGE_KEYS.LANG);
      return saved === 'en' ? 'en' : 'ja';
    } catch (_) {
      return 'ja';
    }
  }

  function getTheme() {
    const docTheme =
      document.documentElement.getAttribute('data-theme') ||
      document.body?.getAttribute('data-theme');
    if (docTheme === 'dark' || docTheme === 'light') return docTheme;
    try {
      const saved = global.localStorage.getItem(STORAGE_KEYS.THEME);
      return saved === 'dark' ? 'dark' : 'light';
    } catch (_) {
      return 'light';
    }
  }

  // =========================================================================
  // 3. WINDOW.NAME & LOCALSTORAGE DATA BRIDGE
  // =========================================================================
  function readWindowBridge() {
    try {
      if (!global.name || !global.name.startsWith('{')) return null;
      const parsed = JSON.parse(global.name);
      if (parsed && parsed.__kanjiNexusBridge) {
        return parsed;
      }
    } catch (_) {
      // Ignore non-JSON window.name values set by external pages
    }
    return null;
  }

  function absorbIncomingBridge() {
    const bridge = readWindowBridge();
    if (!bridge) return null;

    try {
      if (bridge.data && Array.isArray(bridge.data.primaryNodes)) {
        global.localStorage.setItem(
          STORAGE_KEYS.DATA,
          JSON.stringify(bridge.data)
        );
      }
      if (bridge.focusId) {
        global.localStorage.setItem(STORAGE_KEYS.FOCUS_ID, String(bridge.focusId));
      }
      if (bridge.lang === 'ja' || bridge.lang === 'en') {
        global.localStorage.setItem(STORAGE_KEYS.LANG, bridge.lang);
      }
      if (bridge.theme === 'dark' || bridge.theme === 'light') {
        global.localStorage.setItem(STORAGE_KEYS.THEME, bridge.theme);
      }
    } catch (_) {
      // Fallback if localStorage is blocked
    }
    return bridge;
  }

  function getData() {
    const bridge = absorbIncomingBridge();
    try {
      const raw = global.localStorage.getItem(STORAGE_KEYS.DATA);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.primaryNodes)) {
          return parsed;
        }
      }
    } catch (_) {
      // Fall back to bridge payload
    }
    if (bridge && bridge.data && Array.isArray(bridge.data.primaryNodes)) {
      return bridge.data;
    }
    return null;
  }

  function saveData(data) {
    if (!data || !Array.isArray(data.primaryNodes)) return;
    const serialized = JSON.stringify(data);
    try {
      global.localStorage.setItem(STORAGE_KEYS.DATA, serialized);
    } catch (err) {
      console.warn('[NexusHub] Failed to write localStorage:', err);
    }
    // Keep window.name updated in case user triggers browser back/forward
    try {
      const existingBridge = readWindowBridge() || {};
      global.name = JSON.stringify({
        __kanjiNexusBridge: true,
        source: getCurrentFileName(),
        data,
        focusId: existingBridge.focusId || null,
        lang: getLang(),
        theme: getTheme(),
        timestamp: Date.now()
      });
    } catch (_) {}

    dataChangeListeners.forEach((fn) => {
      try {
        fn(data);
      } catch (_) {}
    });
  }

  function consumeFocusId() {
    let focusId = null;

    // 1. Check URL ?focus=...
    try {
      const url = new URL(global.location.href);
      if (url.searchParams.has('focus')) {
        focusId = url.searchParams.get('focus');
        url.searchParams.delete('focus');
        global.history.replaceState({}, '', url.toString());
      }
    } catch (_) {}

    // 2. Check URL #focus=...
    if (!focusId && global.location.hash) {
      const match = global.location.hash.match(/focus=([^&]+)/);
      if (match) {
        focusId = decodeURIComponent(match[1]);
        try {
          const cleanHash = global.location.hash
            .replace(/#?focus=[^&]+&?/, '')
            .replace(/^#$/, '');
          global.history.replaceState(
            {},
            '',
            global.location.pathname + global.location.search + cleanHash
          );
        } catch (_) {}
      }
    }

    // 3. Check window.name bridge
    const bridge = readWindowBridge();
    if (!focusId && bridge && bridge.focusId) {
      focusId = String(bridge.focusId);
    }
    if (bridge && bridge.focusId) {
      try {
        bridge.focusId = null;
        global.name = JSON.stringify(bridge);
      } catch (_) {}
    }

    // 4. Check localStorage focus key
    try {
      const storedFocus = global.localStorage.getItem(STORAGE_KEYS.FOCUS_ID);
      if (!focusId && storedFocus) {
        focusId = storedFocus;
      }
      if (storedFocus) {
        global.localStorage.removeItem(STORAGE_KEYS.FOCUS_ID);
      }
    } catch (_) {}

    return focusId || null;
  }

  function navigate(targetIdOrFile, options = {}) {
    const targetApp = resolveApp(targetIdOrFile);
    if (!targetApp) return;

    // Allow host page to flush unsaved changes before leaving
    if (typeof beforeNavigateCallback === 'function') {
      try {
        beforeNavigateCallback();
      } catch (err) {
        console.warn('[NexusHub] beforeNavigate hook error:', err);
      }
    }

    const latestData = getData();
    const focusId = options.focusId ? String(options.focusId) : null;

    try {
      if (focusId) {
        global.localStorage.setItem(STORAGE_KEYS.FOCUS_ID, focusId);
      } else {
        global.localStorage.removeItem(STORAGE_KEYS.FOCUS_ID);
      }
    } catch (_) {}

    // Pack full state into window.name for seamless file:// transfers
    try {
      global.name = JSON.stringify({
        __kanjiNexusBridge: true,
        source: getCurrentFileName(),
        data: latestData,
        focusId,
        lang: getLang(),
        theme: getTheme(),
        timestamp: Date.now()
      });
    } catch (_) {}

    let destination = targetApp.file;
    if (focusId) {
      const sep = destination.includes('?') ? '&' : '?';
      destination += `${sep}focus=${encodeURIComponent(focusId)}`;
    }

    global.location.href = destination;
  }

  function openInMap(nodeId) {
    navigate('map', { focusId: nodeId });
  }

  // =========================================================================
  // 4. SELF-UPDATING HOTBAR UI INJECTION
  // =========================================================================
  function injectStyles() {
    if (document.getElementById('nexus-hub-styles')) return;
    const style = document.createElement('style');
    style.id = 'nexus-hub-styles';
    style.textContent = `
      .nexus-hub-nav {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 3px;
        border-radius: 999px;
        background: var(--nexus-hub-bg, rgba(148, 163, 184, 0.14));
        border: 1px solid var(--nexus-hub-border, rgba(148, 163, 184, 0.28));
        font-family: 'Noto Sans JP', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        user-select: none;
        flex-shrink: 0;
      }
      [data-theme="dark"] .nexus-hub-nav {
        --nexus-hub-bg: rgba(30, 41, 59, 0.85);
        --nexus-hub-border: rgba(71, 85, 105, 0.55);
      }
      .nexus-hub-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 10px;
        border-radius: 999px;
        border: none;
        background: transparent;
        color: var(--text-muted, #64748b);
        font-size: 12px;
        font-weight: 600;
        line-height: 1.2;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
      }
      .nexus-hub-pill:hover {
        color: var(--text-main, #0f172a);
        background: rgba(148, 163, 184, 0.16);
      }
      [data-theme="dark"] .nexus-hub-pill:hover {
        color: #f8fafc;
        background: rgba(148, 163, 184, 0.18);
      }
      .nexus-hub-pill.active {
        background: var(--accent-primary, #2563eb);
        color: #ffffff !important;
        box-shadow: 0 2px 6px rgba(37, 99, 235, 0.32);
        cursor: default;
      }
      .nexus-hub-icon {
        font-size: 13px;
        line-height: 1;
      }
      /* Standalone floating fallback when a mini-app does not define #nexus-hub-slot */
      .nexus-hub-floating-wrap {
        position: fixed;
        bottom: 14px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9990;
        padding: 4px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.16);
      }
      [data-theme="dark"] .nexus-hub-floating-wrap {
        background: rgba(15, 23, 42, 0.9);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      }
      @media (max-width: 640px) {
        .nexus-hub-pill {
          padding: 4px 8px;
          font-size: 11px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function renderHotbar() {
    if (!document.body) return;
    injectStyles();

    const currentFile = getCurrentFileName();
    const lang = getLang();
    const slot = document.getElementById('nexus-hub-slot');

    let container = document.getElementById('nexus-hub-nav-bar');
    if (!container) {
      container = document.createElement('nav');
      container.id = 'nexus-hub-nav-bar';
      container.className = 'nexus-hub-nav';
      container.setAttribute('aria-label', 'KanjiNexus Hub Navigation');

      if (slot) {
        slot.innerHTML = '';
        slot.appendChild(container);
      } else {
        const floatWrap = document.createElement('div');
        floatWrap.id = 'nexus-hub-floating-wrap';
        floatWrap.className = 'nexus-hub-floating-wrap';
        floatWrap.appendChild(container);
        document.body.appendChild(floatWrap);
      }
    }

    container.innerHTML = '';
    NEXUS_APPS.forEach((app) => {
      const isActive =
        currentFile === app.file ||
        (currentFile === '' && app.id === 'map');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nexus-hub-pill' + (isActive ? ' active' : '');
      btn.dataset.appId = app.id;
      btn.dataset.tipJa = app.descJa || app.ja;
      btn.dataset.tipEn = app.descEn || app.en;
      btn.title = lang === 'en' ? app.descEn || app.en : app.descJa || app.ja;
      btn.setAttribute('aria-current', isActive ? 'page' : 'false');

      const labelText = lang === 'en' ? app.en : app.ja;
      btn.innerHTML = `<span class="nexus-hub-icon" aria-hidden="true">${app.icon}</span><span>${labelText}</span>`;

      if (!isActive) {
        btn.addEventListener('click', () => navigate(app.id));
      }
      container.appendChild(btn);
    });
  }

  // Absorb incoming bridge immediately when script executes
  absorbIncomingBridge();

  // Mount hotbar on DOMContentLoaded (or immediately if already parsed)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderHotbar);
  } else {
    renderHotbar();
  }

  // Keep hotbar synchronized across tabs or when language/theme attributes change
  global.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEYS.LANG || e.key === STORAGE_KEYS.THEME) {
      renderHotbar();
    } else if (e.key === STORAGE_KEYS.DATA && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        if (parsed && Array.isArray(parsed.primaryNodes)) {
          dataChangeListeners.forEach((fn) => fn(parsed));
        }
      } catch (_) {}
    }
  });

  // Watch data-theme changes on <html> so hotbar styling updates instantaneously
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => renderHotbar());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-lang']
    });
  }

  // Public API exposed to all mini-apps
  global.NexusHub = {
    apps: NEXUS_APPS,
    keys: STORAGE_KEYS,
    getData,
    saveData,
    navigate,
    openInMap,
    consumeFocusId,
    getLang,
    getTheme,
    refreshUI: renderHotbar,
    onBeforeNavigate(fn) {
      beforeNavigateCallback = fn;
    },
    onDataChange(fn) {
      if (typeof fn === 'function') dataChangeListeners.add(fn);
    }
  };
})(window);