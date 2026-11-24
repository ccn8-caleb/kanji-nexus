// Pure three-way sync decision. Hashes are of the canonical bundle text, so a
// version bump on Drive without a content change never looks like an edit.
//
//   localHash   this device's data now
//   remoteHash  Drive's data now (null: no file on Drive yet)
//   baseHash    the content both sides had at this device's last sync (null: never synced)
//
// Returns:
//   'push'      Drive has no file, or only this device changed
//   'pull'      only Drive changed
//   'adopt'     both sides already identical: just record it
//   'first'     first sync on this device and the contents differ: ask the user
//   'conflict'  both changed since the last sync: ask the user

export function decide({ localHash, remoteHash, baseHash }) {
  if (remoteHash == null) return 'push';
  if (localHash === remoteHash) return 'adopt';
  if (baseHash == null) return 'first';
  const localChanged = localHash !== baseHash;
  const remoteChanged = remoteHash !== baseHash;
  if (localChanged && remoteChanged) return 'conflict';
  return remoteChanged ? 'pull' : 'push';
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
