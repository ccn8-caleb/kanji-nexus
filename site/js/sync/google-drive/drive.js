// Minimal Drive REST v3 client for one JSON file in the hidden appDataFolder.
// The folder is private to this app: invisible in the Drive UI and to other apps.

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const LEGACY_FILE = 'kanji-nexus.json'; // 0.6.0–0.6.2: the single synced map
export const INDEX_FILE = 'kanji-nexus-index.json'; // list of maps → files
export const mapFileName = (id) => `kanji-nexus-map-${id}.json`;
export const SRS_FILE = 'kanji-nexus-srs.json'; // drill progress (all maps)
const META_FIELDS = 'id,version,modifiedTime';

export class TokenExpiredError extends Error {}

async function call(token, url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  if (res.status === 401) throw new TokenExpiredError('Google token expired');
  if (res.status === 404) return null;
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message || '';
    } catch (_) {}
    throw new Error(`Google Drive ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

// Newest file with this name (two devices connecting at once could create two).
export async function findFile(token, name) {
  const q = encodeURIComponent(`name = '${name}' and trashed = false`);
  const res = await call(token, `${API}?spaces=appDataFolder&q=${q}&orderBy=modifiedTime desc&pageSize=10&fields=files(${META_FIELDS})`);
  return (await res.json()).files?.[0] || null;
}

export async function getMeta(token, id) {
  const res = await call(token, `${API}/${id}?fields=${META_FIELDS}`);
  return res ? res.json() : null;
}

export async function download(token, id) {
  const res = await call(token, `${API}/${id}?alt=media`);
  if (!res) throw new Error('Google Drive file disappeared');
  return res.text();
}

export async function create(token, text, name) {
  const boundary = `kanji-nexus-${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: ['appDataFolder'], mimeType: 'application/json' }) +
    `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
  const res = await call(token, `${UPLOAD}?uploadType=multipart&fields=${META_FIELDS}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

export async function update(token, id, text) {
  const res = await call(token, `${UPLOAD}/${id}?uploadType=media&fields=${META_FIELDS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: text,
  });
  if (!res) throw new Error('Google Drive file disappeared');
  return res.json();
}

// App-data files can't be trashed, only deleted (permanently).
export async function remove(token, id) {
  await call(token, `${API}/${id}`, { method: 'DELETE' });
}
