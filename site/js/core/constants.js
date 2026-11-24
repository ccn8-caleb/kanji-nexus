// Single source of truth for vocabulary metadata shared by every page.
// Adding a tag or link type here makes it available everywhere (map, stats, drill).

export const SCHEMA_VERSION = 2;

export const STORAGE_KEYS = {
  DATA: 'kanji_nexus_data_v2',
  LEGACY_DATA: 'kanji_nexus_data_v1',
  SRS: 'kanji_nexus_srs_v1',
  LANG: 'kanji_nexus_lang',
  THEME: 'kanji_nexus_theme',
};

// Files under site/data/ that make up the starter sample (and a bundle's sections).
export const DATA_FILES = ['kanji', 'words', 'links', 'layout'];

export const GRAMMAR_TAGS = [
  { id: 'suru', ja: 'する動', en: 'Suru-verb' },
  { id: 'intransitive', ja: '自動', en: 'Intransitive' },
  { id: 'transitive', ja: '他動', en: 'Transitive' },
  { id: 'na-adj', ja: 'な形', en: 'Na-adj' },
  { id: 'i-adj', ja: 'い形', en: 'I-adj' },
  { id: 'adverb', ja: '副', en: 'Adverb' },
  { id: 'kana', ja: 'かな表記', en: 'Usually Kana' },
];
export const TAG_IDS = new Set(GRAMMAR_TAGS.map((t) => t.id));

export const LINK_TYPES = {
  related: { ja: '関連語', en: 'Related', short: '関', color: '#64748b' },
  antonym: { ja: '対義語', en: 'Antonym', short: '対', color: '#f43f5e' },
  synonym: { ja: '類義語', en: 'Synonym', short: '類', color: '#0ea5e9' },
  derivative: { ja: '派生語', en: 'Derivative', short: '派', color: '#10b981' },
  lookalike: { ja: '類形語', en: 'Lookalike', short: '似', color: '#f59e0b' },
};

export const DEFAULT_COLORS = { kanji: '#3b82f6', word: '#10b981' };

export const PALETTE = [
  '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444',
  '#06b6d4', '#ec4899', '#6366f1', '#14b8a6', '#64748b',
];

export const KANA_ROWS = [
  { id: 'all', label: '全', chars: '' },
  { id: 'a', label: 'あ', chars: 'あいうえおぁぃぅぇぉ' },
  { id: 'ka', label: 'か', chars: 'かきくけこがぎぐげご' },
  { id: 'sa', label: 'さ', chars: 'さしすせそざじずぜぞ' },
  { id: 'ta', label: 'た', chars: 'たちつてとだぢづでどっ' },
  { id: 'na', label: 'な', chars: 'なにぬねの' },
  { id: 'ha', label: 'は', chars: 'はひふへほばびぶべぼぱぴぷぺぽ' },
  { id: 'ma', label: 'ま', chars: 'まみむめも' },
  { id: 'ya', label: 'や', chars: 'やゆよゃゅょ' },
  { id: 'ra', label: 'ら', chars: 'らりるれろ' },
  { id: 'wa', label: 'わ', chars: 'わをんゎ' },
];

export function dictionaryLinks(label, kind) {
  const q = encodeURIComponent(label);
  if (kind === 'kanji') {
    return [
      { name: '漢字ペディア', url: `https://www.kanjipedia.jp/search?k=${q}&kt=1&sk=leftHand` },
      { name: '漢字辞典オンライン', url: `https://kanji.jitenon.jp/cat/search.php?getdata=${q}` },
      { name: 'Weblio漢字', url: `https://www.weblio.jp/content/${q}` },
      { name: 'コトバンク', url: `https://kotobank.jp/gs/?q=${q}` },
      { name: 'Jisho', url: `https://jisho.org/search/${q}%20%23kanji` },
    ];
  }
  return [
    { name: 'Weblio国語辞典', url: `https://www.weblio.jp/content/${q}` },
    { name: 'コトバンク', url: `https://kotobank.jp/gs/?q=${q}` },
    { name: 'Jisho', url: `https://jisho.org/search/${q}` },
  ];
}
