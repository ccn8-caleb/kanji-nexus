// Transfer plugin: move data between devices with no server and no account.
//
// "Transfer link": the whole bundle is gzipped into the URL fragment (#import=…).
// Fragments are never sent to the web server, so the data only travels inside the
// link itself (via whatever you paste it into). Opening the link offers to import.
//
// "Share file": hands a backup .json to the OS share sheet (AirDrop, Files, Drive…)
// where the browser supports sharing files.

const PREFIX = '#import=';
const SOFT_LIMIT = 60_000; // characters; longer links get truncated by some apps

async function gzipBase64url(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gunzipBase64url(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function copyTransferLink({ store, toast, t }) {
  const payload = await gzipBase64url(JSON.stringify(JSON.parse(store.exportText())));
  const url = `${location.origin}${location.pathname}${PREFIX}${payload}`;
  if (url.length > SOFT_LIMIT) {
    toast(t('データが大きいためリンクが長くなっています。ファイル共有の方が確実です', 'Your data makes a very long link; sharing a file is more reliable'));
  }
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Kanji Nexus', url });
      return;
    } catch (_) {
      // cancelled or unsupported: fall through to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast(t('転送リンクをコピーしました。別の端末で開いてください', 'Transfer link copied — open it on your other device'));
  } catch (_) {
    prompt(t('このリンクをコピーしてください', 'Copy this link'), url);
  }
}

async function shareFile({ store, toast, t }) {
  const file = new File([store.exportText()], 'kanji_nexus.json', { type: 'application/json' });
  if (!navigator.canShare?.({ files: [file] })) {
    toast(t('このブラウザはファイル共有に対応していません。「ファイルに保存」を使ってください', 'File sharing is not supported here — use Download instead'));
    return;
  }
  try {
    await navigator.share({ files: [file], title: 'Kanji Nexus' });
  } catch (_) {}
}

async function importFromFragment({ store, toast, t }) {
  if (!location.hash.startsWith(PREFIX)) return;
  const payload = location.hash.slice(PREFIX.length);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const data = JSON.parse(await gunzipBase64url(payload));
    const k = Object.keys(data.kanji || {}).length;
    const w = Object.keys(data.words || {}).length;
    const ok = confirm(
      t(
        `転送リンクのデータ（漢字 ${k}・語彙 ${w}）を読み込みますか？\nこの端末の現在のデータは置き換えられます。`,
        `Import the data from this transfer link (${k} kanji · ${w} words)?\nThis device's current data will be replaced.`
      )
    );
    if (!ok) return;
    store.importData(data);
    toast(t('転送リンクからデータを読み込みました', 'Data imported from transfer link'));
  } catch (err) {
    alert(t('転送リンクを読み取れませんでした: ', 'Could not read the transfer link: ') + err.message);
  }
}

export default {
  id: 'share-link',
  async install(ctx) {
    ctx.registerDataAction({ id: 'share-link', section: 'transfer', ja: '🔗 転送リンクを作成', en: '🔗 Create transfer link', run: copyTransferLink });
    ctx.registerDataAction({ id: 'share-file', section: 'transfer', ja: '📤 ファイルを共有', en: '📤 Share file', run: shareFile });
    await importFromFragment(ctx);
  },
};
