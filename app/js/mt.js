// 离线机器翻译：opus-mt-en-zh 量化模型
//
// ── 两条路径 ──
//   · 主路径：几个 Worker **并行逐句**翻译。句子之间彼此独立，并行是纯赚；
//     而且推理走出主线程后，翻译期间界面不再被按死。
//   · 兜底：Worker 起不来（或太弱的设备）时在主线程翻，此时才动态加载
//     transformers。
//
// ⚠️ 本文件**不要**在顶层 import transformers.min.js。它是 1MB 的脚本，
//    以前这里静态引入，等于每次开页面都要先解析它才开始渲染。改成
//    「用到才 import」之后首屏少背 1MB。
//
// 逐句推理（batch = 1）这条约束没有变，也不能变：Marian 系模型对 padding 后的
// 批输入会失控，短句被强制解码到 max_new_tokens，出现整段重复与未知符。
// 这里并行的是「不同句子分给不同 Worker」，不是「一个 batch」，所以安全。

const MODELS_BASE = new URL('../models/', import.meta.url).pathname;
const VENDOR_BASE = new URL('../vendor/', import.meta.url).pathname;

/* ---------------- 翻译模型链 ----------------
   英文内容一个模型就够；西语没有现成的 es→zh 量化模型（HF 上根本不存在），
   只能两跳：先 es→en，再把结果交给同一个 en→zh。链长 > 1 时主线程只起
   一个 Worker，因为每个 Worker 要同时持有两份权重 —— 内存翻倍比吞吐减半难受。 */
export const MT_CHAINS = {
  en: ['opus-mt-en-zh'],
  es: ['opus-mt-es-en', 'opus-mt-en-zh'],
};

let srcLang = 'en';
/** 设置源语言（由选中的识别模型决定）。换了语言要重建线程池。 */
export function setLang(lang) {
  const next = MT_CHAINS[lang] ? lang : 'en';
  if (next === srcLang) return;
  srcLang = next;
  dropWorkers();
}

export const chainFor = (lang = srcLang) => MT_CHAINS[lang] || MT_CHAINS.en;
const chainKey = (chain) => chain.join('>');

const WORKER_THREADS = 1;      // 翻译序列短，多线程几乎没收益，算力留给识别
const TASK_TIMEOUT_MS = 90000;

let workers = [];              // 并行翻译线程
let poolPromise = null;
let mainTranslators = [];      // 主线程兜底（也是一串）
let mainLoading = null;

function dropWorkers() {
  for (const w of workers) { try { w.terminate(); } catch {} }
  workers = [];
  poolPromise = null;
  mainTranslators = [];
  mainLoading = null;
  warmPromise = null;
}

/** 起几个翻译线程：每个都要独立持有一份权重，内存小的机器只起一个。
 *  模型链多于一级时固定 1 个 —— 否则两份权重 × 两个线程 = 四份，太狠。 */
function poolSize() {
  if (chainFor().length > 1) return 1;
  const mem = navigator.deviceMemory || 0;
  const hc = navigator.hardwareConcurrency || 4;
  if (mem && mem <= 4) return 1;
  if (hc <= 4) return 1;
  return 2;
}

export async function probeMT() {
  const base = MODELS_BASE.endsWith('/') ? MODELS_BASE : MODELS_BASE + '/';
  for (const id of chainFor()) {
    const url = `${base}${id}/config.json`;
    const res = await fetch(url, { method: 'GET', cache: 'force-cache' });
    if (!res.ok) throw new Error(`本地翻译模型缺失：${url} 返回 ${res.status}`);
  }
  return chainFor().join(' → ');
}

// transformers.js 会从本地目录拉这些文件（相对 models/opus-mt-en-zh/）
const MT_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.json',
  'source.spm',
  'target.spm',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

let warmPromise = null;

/**
 * 只把翻译模型的文件拉进缓存，**不创建 ORT 会话**。
 *
 * 这一步只有网络开销，几乎不吃 CPU，所以可以和识别同时进行；
 * 而真正贵的「读权重 + 图优化」留给空闲时（见 loadMT）或用户真要翻译时。
 */
export function warmupFiles(onProgress) {
  if (warmPromise) return warmPromise;
  const base = MODELS_BASE.endsWith('/') ? MODELS_BASE : MODELS_BASE + '/';
  // 链上每个模型的文件都要预热：西语两跳时只热 en→zh 是不够的
  const urls = [];
  for (const id of chainFor()) for (const f of MT_FILES) urls.push(`${base}${id}/${f}`);
  const key = chainKey(chainFor());
  warmPromise = (async () => {
    let done = 0;
    // 顺序拉而不是并发：目的是「把文件放进缓存」，不是抢时间；
    // 两个几十 MB 的 onnx 一起抢带宽反而两边都慢，还会挤掉正在跑的识别。
    //
    // ⚠️ 光 `await fetch()` **不等于**下完 —— 它只等到响应头，响应体是后台流式
    //    进来的，循环会立刻跑到下一个文件。必须把 body 读完，这条循环才真的是
    //    「一个一个来」。这里踩过一次坑：写成 await fetch 之后，十个文件其实
    //    是同时铺开的，113MB 全挤在一起。
    for (const u of urls) {
      try {
        const res = await fetch(u, { cache: 'force-cache' });
        const reader = res.body?.getReader?.();
        if (reader) { for (;;) { const { done: fin } = await reader.read(); if (fin) break; } }
        else await res.arrayBuffer();
      } catch { /* 单个失败无所谓：真要翻译时还会再拉一次 */ }
      done++;
      onProgress?.({ done, total: urls.length });
    }
  })();
  void key;
  return warmPromise;
}

/* ---------------- 并行路径 ---------------- */

function spawnWorker(onProgress) {
  return new Promise((resolve, reject) => {
    const ver = self.__ECHOLINGO_VER__ || '';
    const url = new URL('./mt-worker.js', import.meta.url);
    if (ver) url.searchParams.set('v', ver);

    let w;
    try { w = new Worker(url, { type: 'module' }); } catch (e) { reject(e); return; }

    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.type === 'ready') { off(); resolve(w); }
      // 转成 app.js 认得的形状：它按 `phase === 'load'` 分支显示「加载翻译模型」。
      // 直接转发 worker 那条消息（只有 type/file/pct）会掉进翻译计数分支，
      // 界面就会显示没被替换的「翻译 {done}/{total} 句」。
      else if (m.type === 'progress') onProgress?.({ phase: 'load', file: m.file, pct: m.pct });
      // 带 task 的 error 是「某一句翻译失败」，不算装载失败
      else if (m.type === 'error' && m.task === undefined) { off(); reject(new Error(m.message || '翻译线程装载失败')); }
    };
    const off = () => w.removeEventListener('message', onMsg);
    w.addEventListener('message', onMsg);
    w.addEventListener('error', () => { off(); reject(new Error('翻译线程启动失败')); });
    const chain = chainFor();
    w.postMessage({ type: 'load', chain, chainKey: chainKey(chain), threads: WORKER_THREADS });
  });
}

/** 装载并行翻译。第一个线程负责真正下载模型，其余命中缓存后很快跟上。 */
export async function loadMT(onProgress) {
  if (workers.length) return true;
  if (poolPromise) return poolPromise;

  poolPromise = (async () => {
    const first = await spawnWorker(onProgress);
    workers.push(first);
    const rest = poolSize() - 1;
    if (rest > 0) {
      const extra = await Promise.all(Array.from({ length: rest }, () => spawnWorker(null)
        .then((w) => { workers.push(w); return w; })
        .catch((e) => { console.warn('[mt] 额外翻译线程装载失败，已跳过', e); return null; })));
      void extra;
    }
    console.info(`[mt] 并行翻译已就绪：${workers.length} 个线程`);
    return true;
  })();

  try {
    return await poolPromise;
  } finally {
    poolPromise = null;
  }
}

function askWorker(w, task, text, maxNew) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('单句翻译超时')); }, TASK_TIMEOUT_MS);
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.task !== task) return;
      // 链长 > 1 时 worker 会一并带回第一跳的结果（mid），见 mt-worker.js
      if (m.type === 'done') { off(); resolve({ out: m.text || '', mid: m.mid || '' }); }
      else if (m.type === 'error') { off(); reject(new Error(m.message || '翻译失败')); }
    };
    const off = () => { clearTimeout(timer); w.removeEventListener('message', onMsg); };
    w.addEventListener('message', onMsg);
    w.postMessage({ type: 'translate', task, text, maxNew });
  });
}

async function translateParallel(texts, { onProgress, signal }) {
  // 每一项是 { out, mid }：out 是整条链的最终输出，mid 是第一跳的输出
  // （英语链为空字符串）。西语模式正好拿 mid 当「英文翻译」那一行。
  const out = new Array(texts.length).fill(null);
  const queue = [];
  for (let i = 0; i < texts.length; i++) {
    if (clip(texts[i])) queue.push({ i, text: texts[i] });
  }
  let done = 0;
  const consume = async (w) => {
    while (queue.length) {
      if (signal?.aborted) return;
      const job = queue.shift();
      const input = clip(job.text);
      // 目标长度随源句长度浮动：长句给足空间，短句不给模型放飞的机会
      const maxNew = Math.max(24, Math.min(200, Math.round(18 + input.length * 1.1)));
      try {
        const r = await askWorker(w, job.i, input, maxNew);
        out[job.i] = { out: tidy(r.out), mid: tidy(r.mid) };
      } catch (e) {
        out[job.i] = { out: '', mid: '' };
      }
      done++;
      onProgress?.({ phase: 'translate', pct: (done / Math.max(1, texts.length)) * 100, done, total: texts.length });
    }
  };
  await Promise.all(workers.map(consume));
  return out;
}

/* ---------------- 主线程兜底 ---------------- */

async function mainPipeline() {
  if (mainTranslators.length) return mainTranslators;
  if (mainLoading) return mainLoading;
  const { pipeline, env } = await import('../vendor/transformers.min.js');
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.localModelPath = MODELS_BASE;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = VENDOR_BASE;
    env.backends.onnx.wasm.numThreads = 2;
    env.backends.onnx.wasm.proxy = false;
  }
  const chain = chainFor();
  mainLoading = (async () => {
    const list = [];
    for (const id of chain) {
      list.push(await pipeline('translation', id, {
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        device: 'wasm',
      }));
    }
    mainTranslators = list;
    mainLoading = null;
    return list;
  })().catch((e) => { mainLoading = null; throw e; });
  return mainLoading;
}

async function translateSerial(texts, { onProgress, signal }) {
  const chain = await mainPipeline();
  const out = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i++) {
    if (signal?.aborted) break;
    const input = clip(texts[i]);
    if (!input) { out[i] = { out: '', mid: '' }; continue; }
    const maxNew = Math.max(24, Math.min(200, Math.round(18 + input.length * 1.1)));
    try {
      let text = input;
      let mid = '';
      for (let k = 0; k < chain.length; k++) {
        const r = await chain[k](text, { max_new_tokens: maxNew });
        text = (Array.isArray(r) ? r[0] : r)?.translation_text || '';
        if (!text) break;
        if (k === 0 && chain.length > 1) mid = text;
      }
      out[i] = { out: tidy(text), mid: tidy(mid) };
    } catch (err) {
      out[i] = { out: '', mid: '' };
    }
    onProgress?.({ phase: 'translate', pct: ((i + 1) / Math.max(1, texts.length)) * 100, done: i + 1, total: texts.length });
    // 每句之间让出主线程，界面保持可交互
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

/* ---------------- 对外 ---------------- */

export function isMTReady() { return workers.length > 0 || mainTranslators.length > 0; }

/**
 * 逐句翻译。句子之间彼此独立，所以并行分发到多个线程。
 *
 * 整条链只跑**一趟**，链上每一跳的结果都留着：西语链
 * （es→en→zh）返回的 mid 是英文、out 是中文，调用方一次就能拿到两行字。
 * 早先这里分两趟（先单跑 es→en 翻出英文，再拿英文跑 en→zh 翻中文），
 * 等于把链跑两遍、慢一倍；而且第二趟喂的是第一趟的**最终**输出，
 * 英文那一行会直接填成中文。
 *
 * @param {string[]} texts
 * @param {{onProgress?:Function, signal?:AbortSignal, from?:string}} o
 *        from: 源语言（'en' | 'es'），由识别模型决定；不传沿用上一次。
 * @returns {Promise<Array<{out:string, mid:string}>>}
 *        out: 整条链的最终译文（永远是中文）；mid: 第一跳的译文
 *        （英语链为 ''，西语链为英文）。
 */
export async function translateMany(texts, { onProgress, signal, from } = {}) {
  if (from) setLang(from);
  try {
    await loadMT(onProgress);
  } catch (e) {
    console.warn('[mt] 并行翻译不可用，改在主线程翻译', e);
    workers = [];
  }
  if (workers.length) return translateParallel(texts, { onProgress, signal });
  return translateSerial(texts, { onProgress, signal });
}

// Marian 模型对超长输入会退化，先按句读切到合适长度再翻译
function clip(text, maxLen = 380) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const at = Math.max(cut.lastIndexOf(','), cut.lastIndexOf(';'), cut.lastIndexOf(' '));
  return at > maxLen * 0.5 ? cut.slice(0, at) : cut;
}

function tidy(s) {
  return String(s)
    .replace(/\s+([，。！？；：、）】」』])/g, '$1')
    .replace(/([（【「『])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
