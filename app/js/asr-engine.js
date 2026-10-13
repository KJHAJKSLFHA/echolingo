// 语音识别引擎（推理本体）
//
// 这个文件同时可以被主线程和 Worker 加载：它只做纯计算，不碰 DOM、不碰 WebAudio。
// 正常路径下它跑在 asr-worker.js 里，主线程因此不会被推理卡住；
// 万一浏览器不允许 Worker，asr.js 会退回在主线程直接调用这里的函数。
//
// 切段（segmentAudio / clampSegments）已经搬到 js/segment.js —— 主线程也要用它
// 做并行分片，而主线程绝不能因此把 1MB 的 transformers.min.js 拉进首屏。
// 这里原样转发，历史调用方不受影响。

import { pipeline, env } from '../vendor/transformers.min.js';
import { DEFAULT_ASR_MODEL, modelsBase } from './models.js';
import { SR, segmentAudio, clampSegments } from './segment.js';

export * from './segment.js';
export { SR };

const MODELS_BASE = modelsBase();
const VENDOR_BASE = new URL('../vendor/', import.meta.url).pathname;

// 英语专用模型不接受 language / task 参数，多语言模型才需要
const isMultilingual = (id) => !/\.en$/i.test(id);

let transcriber = null;
let loadedId = null;       // transcriber 当前对应的模型
let loadedThreads = -1;    // transcriber 当前占用的 wasm 线程数
let pendingId = null;      // 正在加载的模型
let pendingThreads = -1;
let loading = null;
let cancelFlag = false;

/* wasm 线程数怎么选（实测结论，改之前先量一遍）

   在 10 核机器上用真实语音实测 whisper-base（q8，逐词时间戳）：

     1 个会话 × 1 线程   RTF 0.205
     1 个会话 × 4 线程   RTF 0.091     ← 线程只带来 2.25 倍，远不到 4 倍
     4 个会话 × 2 线程   RTF 0.058     ← 最优
     5 个会话 × 2 线程   RTF 0.060
     6 个会话 × 1 线程   RTF 0.063

   原因有两层：
   1. whisper 的 d_model 只有 512，矩阵够小，多线程一加就撞上同步开销，
      线程扩展效率只有五成上下；
   2. 每一段音频（哪怕只有 5 秒）都要付一次约 1.6 秒的「30 秒窗口编码器」
      固定成本 —— 固定成本只能靠**多个会话并行去摊**，多线程对它无能为力。

   所以单会话默认只用 2 线程，把剩下的算力留给 asr-pool.js 的并行分片。
   crossOriginIsolated 不成立时没有 SharedArrayBuffer，只能单线程。 */
export function defaultThreads() {
  if (!self.crossOriginIsolated) return 1;
  const hc = navigator.hardwareConcurrency || 4;
  // ⚠️ 这里只服务**单个会话**（并行池会自己算好每会话线程数传进来，不走这条）。
  // 单会话没有别的会话帮它摊固定成本，线程就该给足：10 核实测 28 秒段
  //   1 线程 4645ms / 4 线程 2327ms / 6 线程 2167ms / 8 线程 2215ms / 10 线程 2429ms
  // 6 之后开始倒退（超订），所以上限压在 6、并且留一个核给界面。
  return Math.max(1, Math.min(6, hc - 1));
}

function configure(threads) {
  // 关键：禁止一切远程模型请求，并显式指定本地 wasm 运行时路径，
  // 否则 transformers.js 会退回到 jsdelivr CDN，破坏离线能力。
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.localModelPath = MODELS_BASE;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = VENDOR_BASE;
    // ⚠️ numThreads 只在 ORT 建 session 时生效，运行时一旦初始化就再也改不动
    //    （实测在同一页面上把 4 改成 1，耗时一模一样）。所以线程数是「一个会话
    //    一次」的决定：想换线程数只能新建会话，别指望重设这个字段能改变什么。
    env.backends.onnx.wasm.numThreads = threads;
    env.backends.onnx.wasm.proxy = false;
  }
}

/** 当前已装载的模型 id（未装载返回 null） */
export function loadedModelId() { return loadedId; }

/**
 * 把模型读进内存。
 * @param {(p:Object)=>void} onProgress
 * @param {string} modelId models/<id>/ 目录名
 * @param {number} [threads] wasm 线程数；不传用 defaultThreads()
 */
export async function loadASR(onProgress, modelId, threads) {
  const id = modelId || loadedId || DEFAULT_ASR_MODEL;
  const th = Math.max(1, Math.round(threads || defaultThreads()));
  if (transcriber && loadedId === id && loadedThreads === th) return transcriber;
  if (loading && pendingId === id && pendingThreads === th) return loading;

  // 换模型或换线程数时先把旧的一份放掉，避免两套权重同时占内存
  transcriber = null;
  loadedId = null;
  loadedThreads = -1;
  configure(th);

  pendingId = id;
  pendingThreads = th;
  loading = pipeline('automatic-speech-recognition', id, {
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    device: 'wasm',
    progress_callback: (p) => {
      if (!onProgress) return;
      if (p.status === 'progress' && p.file) {
        onProgress({ phase: 'load', file: p.file, pct: p.total ? (p.loaded / p.total) * 100 : null });
      } else if (p.status === 'ready') {
        onProgress({ phase: 'load', file: p.file, pct: 100 });
      }
    },
  })
    .then((t) => {
      transcriber = t; loadedId = id; loadedThreads = th;
      loading = null; pendingId = null; pendingThreads = -1;
      return t;
    })
    .catch((e) => {
      loading = null; pendingId = null; pendingThreads = -1;
      transcriber = null; loadedId = null; loadedThreads = -1;
      throw new Error(`模型 ${id} 装载失败：${e?.message || e}`);
    });
  return loading;
}

export function isASRReady() { return !!transcriber; }

export function requestCancel() { cancelFlag = true; }
export function resetCancel() { cancelFlag = false; }

/* ---------------- 识别 ---------------- */

const SPECIAL = /<\|[^|]*\|>/g;

function cleanWords(chunks, offset) {
  const words = [];
  for (const c of chunks || []) {
    const text = String(c.text || '').replace(SPECIAL, '').trim();
    if (!text) continue;
    let [s, e] = c.timestamp || [];
    if (s === null || s === undefined) continue;
    if (e === null || e === undefined) e = s + 0.3;
    if (e < s) { const t = e; e = s; s = t; }
    words.push({ text, start: s + offset, end: Math.max(e + offset, s + offset + 0.05) });
  }
  return words;
}

/* ---------------- 只有文本时：切句 + 估算时间 ----------------

   没有逐词时间戳时（用户选了「关闭」，或逐词那一次失败退回），pipeline 只给
   一整段文本。若把它当成一个「词」交上去，每个 29 秒的段就会变成一句 90 词的
   巨型句子 —— 右侧既没法逐句跳转，也没法跟读。这里按句末标点切成句，再按
   字符数把这一段的时长摊到每句上：时间轴是估算的（真实时间戳拿不到），
   但句子边界与逐句导航都是准的。

   返回的每一项是**一句**，不是一词；下游 groupWordsIntoSentences 见到句末
   标点会各自成句，wordTimings() 发现词数对不上会自己退化成按长度分摊。
------------------------------------------------- */

const SENT_END = /([.!?…]["'”’)\]]*)\s+/g;

function textToWords(text, dur) {
  const clean = String(text || '').replace(SPECIAL, '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const pieces = [];
  let last = 0;
  SENT_END.lastIndex = 0;
  for (let m; (m = SENT_END.exec(clean)); ) {
    const piece = clean.slice(last, m.index + m[1].length).trim();
    if (piece) pieces.push(piece);
    last = m.index + m[0].length;
  }
  const tailText = clean.slice(last).trim();
  if (tailText) pieces.push(tailText);
  if (!pieces.length) return [];

  const weights = pieces.map((s) => s.length + 4);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const span = Math.max(0.3, dur || 0.3);
  const out = [];
  let t = 0;
  for (let i = 0; i < pieces.length; i++) {
    const d = i === pieces.length - 1 ? span - t : (weights[i] / sum) * span;
    const step = Math.max(0.05, d);
    out.push({ text: pieces[i], start: t, end: t + step });
    t += step;
  }
  return out;
}

/**
 * 跑单个音频段（**不切段**），返回该段内的词。
 *
 * 这是并行分片的原子操作：每个 Worker 拿一段、独立跑完、把词交给主线程。
 * 段与段之间本来就不重叠，所以并行拼出来的结果与串行逐段跑**完全一致**，
 * 不牺牲任何准确度。
 *
 * @param {Float32Array} samples 16kHz 单声道，必须短于 30 秒
 * @param {Object} o
 * @param {boolean} o.wordTimestamps
 * @param {string} o.modelId
 * @param {number} [o.threads] 必须与装载时一致，否则会触发重新装载
 * @returns {Promise<Array<{text:string,start:number,end:number}>>} 段内相对时间
 */
export async function transcribeSegment(samples, { wordTimestamps = true, modelId, threads } = {}) {
  const asr = await loadASR(null, modelId, threads);
  const genOpts = isMultilingual(loadedId || modelId || DEFAULT_ASR_MODEL)
    ? { language: 'en', task: 'transcribe' }
    : {};
  const dur = samples.length / SR;

  // ⚠️ return_timestamps 只能用 'word' 或 false，**绝不能用 true**。
  //
  // 本仓库 vendor/transformers.min.js 实测（whisper-base.en q8，真实语音，6 线程）：
  //   'word' → 正常，带逐词时间戳；中位 2231ms
  //   false  → 文本正常，但 chunks 为空（完全没有时间戳）；中位 1979ms
  //   true   → 只要这一段是从连续语音**中间**切出来的，就返回 text:'' / chunks:[]，
  //            耗时只剩 780ms —— 它靠模型自己吐时间戳 token 来闭合分段，
  //            吐不出来就只剩空串。而我们的段几乎全部是中间切出来的。
  //
  // 历史上这里写的是 `wordTimestamps ? 'word' : true`，于是「长视频自动关掉
  // 逐词时间戳」直接等于「长视频一个字幕都识别不出来」。不要再走回去。
  let out;
  try {
    out = await asr(samples, {
      return_timestamps: wordTimestamps ? 'word' : false,
      force_full_sequences: false,
      ...genOpts,
    });
  } catch (err) {
    if (!wordTimestamps) throw err;
    // 逐词时间戳失败 → 退到「只要文本」，时间轴交给 textToWords 估算
    out = await asr(samples, { return_timestamps: false, force_full_sequences: false, ...genOpts });
  }

  if (out?.chunks?.length) return cleanWords(out.chunks, 0);
  return textToWords(out?.text || '', dur);
}

/**
 * 串行识别整条音轨（内部自己切段）。只在并行池起不来时兜底，
 * 正常路径走 asr-pool.js 的多会话并行。
 *
 * @param {Float32Array} pcm 16kHz 单声道
 * @param {Object} o
 * @param {(info:Object)=>void} o.onProgress  段级进度
 * @param {boolean} o.wordTimestamps
 * @param {(words:Array, seg:number, total:number)=>void} o.onWords  每段结束后的累积词
 * @param {()=>boolean} o.shouldCancel  段边界处的取消检查
 * @param {number} [o.threads]
 * @returns {Promise<{words:Array, cancelled:boolean}>}
 */
export async function transcribe(pcm, { onProgress, wordTimestamps = true, onWords, shouldCancel, modelId, threads } = {}) {
  await loadASR((p) => onProgress?.({ ...p, pct: p.pct ?? 0 }), modelId, threads);
  const segs = clampSegments(segmentAudio(pcm));
  const all = [];
  const totalSamples = pcm.length || 1;
  const isCancelled = () => cancelFlag || !!shouldCancel?.();
  const t0 = performance.now();
  let cancelled = false;

  for (let i = 0; i < segs.length; i++) {
    if (isCancelled()) { cancelled = true; break; }
    const seg = segs[i];
    const offset = seg.start / SR;
    const words = await transcribeSegment(pcm.slice(seg.start, seg.end), { wordTimestamps, modelId, threads });
    for (const w of words) { w.start += offset; w.end += offset; }
    all.push(...words);
    onWords?.(all, i + 1, segs.length);
    const elapsed = (performance.now() - t0) / 1000;
    const etaSec = seg.end > 0 ? Math.max(0, (elapsed / seg.end) * (totalSamples - seg.end)) : null;
    onProgress?.({
      phase: 'transcribe',
      pct: (seg.end / totalSamples) * 100,
      seg: i + 1, total: segs.length,
      words: all.length,
      etaSec,
    });
    // 段与段之间让出一次宏任务：
    //   - Worker 场景下，让取消消息有机会被派发
    //   - 主线程兜底场景下，让浏览器有机会重绘刚追加的字幕
    await new Promise((r) => setTimeout(r, 0));
  }
  return { words: all, cancelled: cancelled || isCancelled() };
}
