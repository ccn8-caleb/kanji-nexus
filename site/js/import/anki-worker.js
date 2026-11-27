// Reads an Anki package (.apkg / .colpkg) off the main thread and returns plain data:
//   { format, crt, noteTypes: [{ id, name, fields, count }], decks: [{ id, name, count }],
//     notes: [{ id, mid, did, flds }], sched: { [noteId]: card } }
//
// Classic worker (not a module) so it can importScripts() the vendored UMD builds:
// sql.js (SQLite compiled to WebAssembly) and fzstd (Zstandard, for the newest format).
// Only the collection is unpacked — media files in the zip are never read.
//
// Collection formats, newest first (a package can hold several; the newest is complete):
//   collection.anki21b   Anki 2.1.50+: zstd-compressed SQLite, schema 18 (notetypes/fields tables)
//   collection.anki21    Anki 2.1.x:   SQLite, note types as JSON in col.models
//   collection.anki2     Anki 2.0 (or a "please update Anki" stub next to anki21b)

/* global initSqlJs, fzstd */
const BUILD = new URL(self.location.href).searchParams.get('v') || 'dev';
importScripts(`vendor/sql-wasm-browser.js?v=${BUILD}`, `vendor/fzstd.js?v=${BUILD}`);

const progress = (step) => self.postMessage({ progress: step });

// ---------------------------------------------------------------------------
// Zip: central directory → entry, read with File.slice (no full-file read)
// ---------------------------------------------------------------------------
async function bytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

async function zipEntries(file) {
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await bytes(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // Zip64: the locator sits just before the end record.
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new Error('unsupported zip');
    const recOffset = u64(tail, loc + 8);
    const rec = await bytes(file, recOffset, recOffset + 56);
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  const cd = await bytes(file, cdOffset, cdOffset + cdSize);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let p = 0, n = 0; n < count && u32(cd, p) === 0x02014b50; n++) {
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
    let size = u32(cd, p + 24);
    let compSize = u32(cd, p + 20);
    let offset = u32(cd, p + 42);
    // Zip64 extra field carries whichever values overflowed, in this order.
    for (let e = p + 46 + nameLen; e < p + 46 + nameLen + extraLen; ) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
        if (compSize === 0xffffffff) (compSize = u64(cd, q)), (q += 8);
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      e += 4 + len;
    }
    entries.set(name, { method: u16(cd, p + 10), size, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(file, entry) {
  const head = await bytes(file, entry.offset, entry.offset + 30);
  if (u32(head, 0) !== 0x04034b50) throw new Error('corrupt zip');
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const raw = file.slice(start, start + entry.compSize);
  if (entry.method === 0) return new Uint8Array(await raw.arrayBuffer());
  if (entry.method === 8) return new Uint8Array(await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  throw new Error(`unsupported zip compression (${entry.method})`);
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------
function rows(db, sql) {
  const out = [];
  const stmt = db.prepare(sql);
  try {
    while (stmt.step()) out.push(stmt.get());
  } finally {
    stmt.free();
  }
  return out;
}

function readCollection(db) {
  const tables = new Set(rows(db, "select name from sqlite_master where type = 'table'").map((r) => r[0]));
  const [crt, modelsJson, decksJson] = rows(db, 'select crt, models, decks from col')[0];
  let noteTypes;
  let decks;
  if (tables.has('notetypes')) {
    // Schema 18
    const fields = new Map();
    for (const [ntid, ord, name] of rows(db, 'select ntid, ord, name from fields')) {
      if (!fields.has(ntid)) fields.set(ntid, []);
      fields.get(ntid)[ord] = name;
    }
    noteTypes = rows(db, 'select id, name from notetypes').map(([id, name]) => ({ id: String(id), name, fields: fields.get(id) || [] }));
    decks = rows(db, 'select id, name from decks').map(([id, name]) => ({ id: String(id), name: String(name).split('\x1f').join('::') }));
  } else {
    noteTypes = Object.values(JSON.parse(modelsJson || '{}')).map((m) => ({ id: String(m.id), name: m.name, fields: (m.flds || []).sort((a, b) => a.ord - b.ord).map((f) => f.name) }));
    decks = Object.values(JSON.parse(decksJson || '{}')).map((d) => ({ id: String(d.id), name: d.name }));
  }

  // Each note's most advanced card (longest interval, then most reviews) and its deck.
  const sched = {};
  const deckOf = {};
  for (const [nid, did, odid, type, queue, due, ivl, factor, reps, lapses] of rows(db, 'select nid, did, odid, type, queue, due, ivl, factor, reps, lapses from cards')) {
    const key = String(nid);
    deckOf[key] ??= String(odid || did); // filtered decks remember the home deck in odid
    const card = { type, queue, due, ivl, factor, reps, lapses };
    const best = sched[key];
    if (!best || ivl > best.ivl || (ivl === best.ivl && reps > best.reps)) sched[key] = card;
  }

  const notes = rows(db, 'select id, mid, flds from notes').map(([id, mid, flds]) => ({ id: String(id), mid: String(mid), did: deckOf[String(id)] || '', flds: String(flds).split('\x1f') }));
  const typeCount = {};
  const deckCount = {};
  for (const n of notes) {
    typeCount[n.mid] = (typeCount[n.mid] || 0) + 1;
    deckCount[n.did] = (deckCount[n.did] || 0) + 1;
  }
  return {
    crt: Number(crt),
    noteTypes: noteTypes.map((nt) => ({ ...nt, count: typeCount[nt.id] || 0 })).filter((nt) => nt.count),
    decks: decks.map((d) => ({ ...d, count: deckCount[d.id] || 0 })).filter((d) => d.count),
    notes,
    sched,
  };
}

self.onmessage = async ({ data: { file } }) => {
  let db = null;
  try {
    progress('unzip');
    const entries = await zipEntries(file);
    const name = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find((n) => entries.has(n));
    if (!name) throw new Error('no Anki collection in this file');
    let data = await readEntry(file, entries.get(name));
    if (name.endsWith('b')) {
      progress('zstd');
      data = fzstd.decompress(data);
    }
    progress('sqlite');
    const SQL = await initSqlJs({ locateFile: (f) => `vendor/${f}?v=${BUILD}` });
    db = new SQL.Database(data);
    data = null;
    // Schema 18 declares columns with Anki's own "unicase" collation, which sql.js
    // doesn't have: some tables then can't be read at all ("no query solution").
    // Drop the collation from the schema and reopen so SQLite re-reads it.
    if (rows(db, "select count(*) from sqlite_master where sql like '%unicase%'")[0][0]) {
      db.run("PRAGMA writable_schema = ON; UPDATE sqlite_master SET sql = replace(sql, 'COLLATE unicase', '') WHERE sql LIKE '%unicase%'; PRAGMA writable_schema = OFF;");
      const fixed = db.export();
      db.close();
      db = new SQL.Database(fixed);
    }
    progress('read');
    self.postMessage({ result: { format: name, ...readCollection(db) } });
  } catch (err) {
    self.postMessage({ error: err?.message || String(err) });
  } finally {
    db?.close();
  }
};
