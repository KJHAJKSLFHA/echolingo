// 离线词典：按首字母分片懒加载，附带词形还原
// 词条格式（紧凑数组）: [音标, 中文释义, 词性, 英文释义, 词频排名, 词形变化]，尾部空值已裁剪

const BASE = new URL('../dict/', import.meta.url).href;

const shards = new Map();      // letter -> Promise<Object>
let core = null;
let lemma = null;
let meta = null;

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export async function initDict(onProgress) {
  onProgress?.('载入核心词表…');
  [core, lemma, meta] = await Promise.all([
    fetchJSON(BASE + 'core.json'),
    fetchJSON(BASE + 'lemma.json'),
    fetchJSON(BASE + 'meta.json'),
  ]);
  return { coreSize: Object.keys(core).length, total: meta.entries, source: meta.source };
}

export function dictMeta() { return meta; }

async function shard(letter) {
  // 词条经 normalizeWord 处理后首字符必为 a-z，分片名与之直接对应
  const key = /^[a-z]$/.test(letter) ? letter : 'a';
  if (!shards.has(key)) {
    shards.set(key, fetchJSON(BASE + key + '.json').catch(() => ({})));
  }
  return shards.get(key);
}

export function normalizeWord(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[^a-z]+|[^a-z'\-]+$/g, '');
}

// 常见屈折变化的兜底还原规则（词典 lemma 表未覆盖时使用）
function ruleCandidates(w) {
  const out = [];
  const push = (x) => { if (x && x !== w && x.length > 1) out.push(x); };
  if (w.endsWith("'s")) push(w.slice(0, -2));
  if (w.endsWith('ies')) push(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) { push(w.slice(0, -2)); push(w.slice(0, -1)); }
  if (w.endsWith('s')) push(w.slice(0, -1));
  if (w.endsWith('ied')) push(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) {
    push(w.slice(0, -2));
    push(w.slice(0, -1));
    if (/([bdfglmnprt])\1ed$/.test(w)) push(w.slice(0, -3));
  }
  if (w.endsWith('ing')) {
    push(w.slice(0, -3));
    push(w.slice(0, -3) + 'e');
    if (/([bdfglmnprt])\1ing$/.test(w)) push(w.slice(0, -4));
  }
  if (w.endsWith('ly')) { push(w.slice(0, -2)); push(w.slice(0, -2) + 'e'); }
  if (w.endsWith('er')) { push(w.slice(0, -2)); push(w.slice(0, -1)); }
  if (w.endsWith('est')) { push(w.slice(0, -3)); push(w.slice(0, -2)); }
  if (w.endsWith('ier')) push(w.slice(0, -3) + 'y');
  if (w.endsWith('iest')) push(w.slice(0, -4) + 'y');
  return out;
}

function pack(raw, matchedForm) {
  if (!raw) return null;
  const [phonetic = '', trans = '', pos = '', engdef = '', rank = 0, exch = ''] = raw;
  return {
    word: matchedForm,
    phonetic: phonetic ? '/' + phonetic.replace(/^\/|\/$/g, '') + '/' : '',
    rawPhonetic: phonetic,
    trans, pos, engdef, rank, exch,
  };
}

const cache = new Map();

export async function lookup(rawWord) {
  const word = normalizeWord(rawWord);
  if (!word) return null;
  if (cache.has(word)) return cache.get(word);

  const resolve = async (w) => {
    const letter = w[0];
    const bucket = await shard(letter);
    if (bucket[w]) return pack(bucket[w], w);
    // 分片未命中时回到核心表（同一字母分片可能已含该词，此处覆盖边界情况）
    if (core && core[w]) return pack(core[w], w);
    return null;
  };

  let hit = await resolve(word);

  if (!hit) {
    const bases = [];
    const l = lemma?.[word];
    if (l) bases.push(l);
    bases.push(...ruleCandidates(word));
    const seen = new Set();
    for (const b of bases) {
      if (!b || seen.has(b)) continue;
      seen.add(b);
      const r = await resolve(b);
      if (r) { hit = { ...r, matchedForm: b, queryForm: word, inflected: true }; break; }
    }
  }

  const result = hit ? { ...hit, query: word } : null;
  cache.set(word, result);
  return result;
}

// 供生词本过滤使用：判断一个词是否"值得收藏"（过滤掉极常见功能词）
const STOP = new Set(('a an the and or but if of to in on at for with from by as is am are was were be been being ' +
  'do does did have has had will would shall should can could may might must i you he she it we they me him her us them ' +
  'my your his its our their this that these those so not no yes there here then than too very just also only').split(' '));
export const isStopWord = (w) => STOP.has(normalizeWord(w));
