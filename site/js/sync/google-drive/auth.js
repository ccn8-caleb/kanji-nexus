// Google Identity Services (GIS) token model, browser-only: no backend, no refresh tokens.
// Tokens live about an hour; getting a new one needs a user click (popup), so callers
// only request interactively from button handlers and otherwise use cachedToken().

export const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
// localStorage so every tab and page reload within the token's ~1h lifetime can sync
// without another click. The token only grants this app's hidden Drive folder.
const TOKEN_KEY = 'kanji_nexus_gdrive_token';
const EXPIRY_MARGIN_MS = 60_000;

let gisPromise = null;
let tokenClient = null;
let pending = null;

export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('Could not load Google sign-in'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export function cachedToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (saved && saved.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return saved.accessToken;
  } catch (_) {}
  return null;
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (_) {}
}

export class AuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // 'popup_closed' | 'popup_failed_to_open' | 'access_denied' | 'scope_denied' | …
  }
}

function ensureClient(clientId) {
  if (tokenClient) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: (resp) => {
      const p = pending;
      pending = null;
      if (!p) return;
      if (resp.error) return p.reject(new AuthError(resp.error, resp.error_description));
      // Users can untick the Drive permission on the consent screen.
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) return p.reject(new AuthError('scope_denied'));
      const expiresAt = Date.now() + Number(resp.expires_in || 3600) * 1000;
      try {
        localStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken: resp.access_token, expiresAt }));
      } catch (_) {}
      p.resolve(resp.access_token);
    },
    error_callback: (err) => {
      const p = pending;
      pending = null;
      p?.reject(new AuthError(err?.type || 'unknown'));
    },
  });
}

// Must be called from a user gesture (click) or browsers may block the popup.
// prompt '' asks for consent only the first time; later it is usually a quick popup.
export async function requestToken(clientId) {
  await loadGis();
  ensureClient(clientId);
  pending?.reject(new AuthError('superseded'));
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

export async function revoke() {
  const token = cachedToken();
  clearToken();
  if (!token) return;
  try {
    await loadGis();
    await new Promise((resolve) => google.accounts.oauth2.revoke(token, resolve));
  } catch (_) {}
}
