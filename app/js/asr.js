// 语音识别（主线程侧）
//
// 分工：
//   - 音轨解码留在主线程（OfflineAudioContext 只在 window 上可用）
//   - 推理交给 js/asr-worker.js，主线程在识别期间保持流畅
//   - 万一浏览器不允许 Worker，自动退回主线程直接调用 asr-engine.js
//
// 对外统一暴露：probeASR / loadASR / isASRReady / currentModelId / setModel /
//              decodeAudio / transcribe / cancel
//
// 可靠性约定（踩过坑，别删）：
//   1. **每一次等待都有空闲超时。** Worker 超过阈值不出声就当作卡死：
//      终止它、把错误抛给调用方、界面给出提示。以前没有这层保护，
//      模型装载或推理出错时界面会永远停在「正在装载模型…」，什么都不报。
//   2. **回退主线程之前必须先 terminate Worker。** 否则两套 onnxruntime
//      session 同时占内存，主线程连音轨解码都会被拖到几乎不动。
//   3. 出错分两类：
//      · transport（Worker 本身不可用：启动失败、卡死被终止）→ 静默回退主线程；
//      · 普通错误（模型装载失败、推理报错）→ 如实抛出，不做无谓的重跑。

import { DEFAULT_ASR_MODEL, LS_ASR_CACHED, isModelCached } from './models.js';
import { createASRPool, pickPoolShape } from './asr-pool.js';
import { segmentAudio, clampSegments } from './segment.js';

const MODELS_BASE = new URL('../models/', import.meta.url).pathname;
export const SR = 16000;

const LOAD_IDLE_MS = 300000;    // 装载模型：5 分钟没有任何进度才算卡死
                                // （慢网络下 80MB 的 base 模型要下好几分钟，阈值太小会误杀）
const RUN_IDLE_MS = 180000;     // 识别：3 分钟没有任何回包就算卡死

let worker = null;
let workerCreated = false;
let workerModelId = null;   // worker 内当前装载的模型
let workerBroken = false;   // 已经确认 worker 走不通，后续直接走主线程
let modelReady = false;     // 模型是否已就绪（worker 或主线程任一）
let modelId = DEFAULT_ASR_MODEL;
let loadProgress = null;    // 无识别任务时，模型加载进度接到这里
let pending = null;         // 当前正在等待的请求

const transportError = (msg) => { const e = new Error(msg); e.transport = true; return e; };

/* ---------------- Worker 生命周期 ---------------- */

function dropWorker(broken = true) {
  try { worker?.terminate(); } catch {}
  worker = null;
  workerCreated = false;
  workerModelId = null;
  workerBroken = broken;
}

/** 终止 Worker；若正有请求在等，用 transport 错误把它叫醒 */
function killWorker() {
  dropWorker();
  if (pending) {
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.reject(transportError('识别线程已终止'));
  }
}

function onWorkerMessage(ev) {
  const m = ev.data || {};
  switch (m.type) {
    case 'progress':
      (pending?.onProgress || loadProgress)?.(m);
      break;
    case 'ready': {
      workerModelId = m.modelId || modelId;
      const p = pending;
      pending = null;
      if (p) { clearTimeout(p.timer); p.resolve(true); }
      break;
    }
    case 'words':
      pending?.onWords?.(m.words, m.seg, m.total);
      break;
    case 'done': {
      const p = pending;
      pending = null;
      if (p) { clearTimeout(p.timer); p.resolve({ words: m.words, cancelled: !!m.cancelled }); }
      break;
    }
    case 'error': {
      const p = pending;
      pending = null;
      const raw = new Error(m.message || '识别线程内部错误');
      // 装载阶段的失败要分两种，混在一起会踩坑：
      //   · 下载类失败（network / fetch）：网络问题，重试或等缓存就能好，
      //     Worker 本身没问题 —— 必须如实上报，绝不能当成「Worker 不可用」去回退主线程，
      //     否则会在主线程把几十 MB 模型再下一遍，首次使用要干等两轮。
      //   · 其它装载失败（wasm 起不来、模型文件损坏等）：Worker 这条路走不通，回退主线程试试。
      const netish = /network|fetch|load failed|网络/i.test(raw.message);
      const err = (m.phase === 'load' && !netish) ? transportError(raw.message) : raw;
      if (p) { clearTimeout(p.timer); p.reject(err); }
      break;
    }
    default: break;
  }
  bumpIdle();
}

/** 每收到一条消息就把空闲计时器往后推 */
function bumpIdle() {
  if (!pending) return;
  const p = pending;
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    if (pending !== p) return;
    pending = null;
    dropWorker();
    p.reject(transportError(`${p.tag === 'load' ? '模型装载' : '识别'}超过 ${Math.round(p.idleMs / 1000)} 秒没有任何进展，已终止`));
  }, p.idleMs);
}

function ensureWorker() {
  if (worker && workerCreated) return true;
  if (workerBroken) throw transportError('识别线程不可用');
  try {
    const w = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
    worker = w;
    w.addEventListener('message', onWorkerMessage);
    w.addEventListener('error', (ev) => {
      ev.preventDefault?.();
      const msg = ev.message || '识别线程启动失败';
      dropWorker();
      if (pending) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.reject(transportError(msg));
      }
    });
    workerCreated = true;
  } catch (e) {
    dropWorker();
    throw transportError(`无法创建识别线程：${e?.message || e}`);
  }
  return true;
}

/** 发一条消息给 Worker，并等它的回包（带空闲超时）
 *
 *  Worker 同一时刻只处理一个请求（pending 是单槽）。所以这里用一条串行链把请求排好队：
 *  开机预热和用户点的识别会几乎同时到达，以前后到的那个会被「已有识别任务在进行中」
 *  直接拒绝 —— 用户点了按钮却看到报错。排队之后两者依次执行，先到的装载完，
 *  后到的发现模型已在内存就直接跑，谁都不会被拒。
 */
let chain = Promise.resolve();

function ask(message, { transfer, idleMs, onProgress, onWords, tag } = {}) {
  const run = () => new Promise((resolve, reject) => {
    if (!worker) { reject(transportError('识别线程不可用')); return; }
    if (pending) { reject(new Error('内部错误：请求没有排队，出现了并发')); return; }
    const entry = { tag, onProgress, onWords, resolve, reject, idleMs, timer: 0 };
    pending = entry;
    entry.timer = setTimeout(() => {
      if (pending !== entry) return;
      pending = null;
      dropWorker();
      reject(transportError(`${tag === 'load' ? '模型装载' : '识别'}超过 ${Math.round(idleMs / 1000)} 秒没有任何进展，已终止`));
    }, idleMs);
    try {
      worker.postMessage(message, transfer || []);
    } catch (e) {
      pending = null;
      clearTimeout(entry.timer);
      reject(e);
    }
  });
  // 前一个请求无论成功与否，都接着跑下一个
  const p = chain.then(run, run);
  chain = p.then(() => {}, () => {});
  return p;
}

/* ---------------- 并行识别池（主路径） ----------------

   实测（10 核、真实语音、whisper-base q8，逐词时间戳）：

     1 会话 × 4 线程   RTF 0.091   ← 老实现的水平
     4 会话 × 2 线程   RTF 0.058   ← 现在的主力，快约 1.6 倍
     6 会话 × 1 线程   RTF 0.063

   为什么不是「一个会话多给几个线程」：whisper 的矩阵小，线程扩展效率只有
   五成；而且每段都要付约 1.6 秒的固定窗口开销，只有多会话并行能摊掉它。
   段与段本来就不重叠，并行拼出来的词序列与串行逐段跑完全一致 —— 纯赚吞吐，
   不牺牲一点准确度。

   池子常驻（模型留在内存里），只有换模型时才重建。 */

let pool = null;
let poolKey = '';         // pool 对应的模型 id
let poolPromise = null;   // 正在装载中的池子（防止并发重复建）
let poolPromiseKey = '';
let poolFailed = false;   // 池子这条路彻底走不通 → 退回单会话路径

function dropPool() {
  if (pool) { try { pool.terminate(); } catch {} pool = null; }
  poolKey = '';
}

async function ensurePool(onProgress) {
  if (pool && !pool.disposed && poolKey === modelId) return pool;
  // 开机预热和用户点击识别几乎同时到达。没有这一层的话，装载期间 pool 还是
  // null，后到的调用会**再建一个池子** —— 白装一份模型（多占几百 MB 内存），
  // 而且两个池子各跑一半的段，进度也就乱了。同一模型只允许一个装载任务在飞。
  if (poolPromise && poolPromiseKey === modelId) return poolPromise;

  const key = modelId;
  const task = (async () => {
    // 乐观按「这条音轨会有好几段」预备，免得识别开始才发现池子太小
    const { size, threads } = pickPoolShape(4);
    // 首次下载（本机还没这个模型）才开并发预取：单连接被限速，
    // 两条连接同时铺开明显更快；已经缓存过的就老实走缓存，别白读 76MB。
    const p = createASRPool({ modelId: key, size, threads, prefetch: !isModelCached(LS_ASR_CACHED) });
    try {
      const loads = await p.loadAll(onProgress);
      if (!loads.length) throw new Error('没有可用的识别会话');
    } catch (e) {
      try { p.terminate(); } catch {}
      throw transportError(`并行识别池装载失败：${e?.message || e}`);
    }
    // 装载期间用户换了模型：这一份直接作废，别让它顶掉新的
    if (key !== modelId) {
      try { p.terminate(); } catch {}
      throw new Error('识别模型已切换，请重新开始');
    }
    if (pool) { try { pool.terminate(); } catch {} }
    pool = p;
    poolKey = key;
    return pool;
  })();

  poolPromise = task;
  poolPromiseKey = key;
  try {
    return await task;
  } finally {
    if (poolPromise === task) { poolPromise = null; poolPromiseKey = ''; }
  }
}

/* ---------------- 模型选择 ---------------- */

export function currentModelId() { return modelId; }

/** 切换识别模型。池子会在下一次任务时整体重建。 */
export function setModel(id) {
  if (!id || id === modelId) return;
  modelId = id;
  modelReady = false;
  workerModelId = null;
  dropPool();
}

async function ensureModelLoaded(onProgress) {
  ensureWorker();
  if (onProgress) loadProgress = onProgress;
  if (workerModelId === modelId) return true;
  const opts = { idleMs: LOAD_IDLE_MS, tag: 'load', onProgress };
  try {
    await ask({ type: 'load', modelId }, opts);
  } catch (e) {
    // 下载类失败多半是网络抖动（长连接被中间层掐断之类）。
    // 换一个干净的 Worker 再试一次：此时 Service Worker 通常已经缓存了一部分，
    // 第二次成功率明显更高，用户也就不必自己再点一遍重新识别。
    if (!isNetworkError(e)) throw e;
    console.warn('[asr] 模型下载失败，重试一次', e);
    // 立刻把干净的 Worker 建回来再等重试间隔：队列里可能还排着别的请求，
    // 中间留一段「worker 为 null」的空窗会让它们平白失败。
    workerBroken = false;
    dropWorker(false);
    ensureWorker();
    await new Promise((r) => setTimeout(r, 1500));
    await ask({ type: 'load', modelId }, opts);
  }
  return true;
}

const isNetworkError = (e) => /network|fetch|load failed|网络/i.test((e && e.message) || '');

/* ---------------- 预检 ---------------- */

// 确认本地文件确实可读，便于给出准确报错而不是笼统的加载失败
export async function probeASR(id) {
  const mid = id || modelId;
  const base = MODELS_BASE.endsWith('/') ? MODELS_BASE : MODELS_BASE + '/';
  const url = `${base}${mid}/config.json`;
  const res = await fetch(url, { method: 'GET', cache: 'force-cache' });
  if (!res.ok) throw new Error(`本地模型缺失：${mid}（${url} 返回 ${res.status}）`);
  const j = await res.json();
  return j._name_or_path || mid;
}

/** 把模型读进内存。优先装在并行池里，池子起不来才退回单会话 / 主线程。 */
export async function loadASR(onProgress, id) {
  if (id) setModel(id);
  loadProgress = onProgress || null;

  // 并行池也要先预热：这样「导入视频即出字幕」不用再等模型冷启动
  if (!poolFailed) {
    try {
      await ensurePool(onProgress);
      modelReady = true;
      return true;
    } catch (e) {
      console.warn('[asr] 并行池不可用，改用单会话路径', e);
      poolFailed = true;
      dropPool();
    }
  }

  if (!workerBroken) {
    try {
      await ensureModelLoaded(onProgress);
      modelReady = true;
      return true;
    } catch (e) {
      if (!e?.transport) throw e;
      console.warn('[asr] worker 不可用，改用主线程', e);
      killWorker();
    }
  }
  const eng = await fallbackEngine();
  await eng.loadASR(onProgress, modelId);
  modelReady = true;
  return true;
}

export function isASRReady() { return modelReady; }

/** 当前并行配置，给设置面板显示用（用户能自己看出是不是被降级了） */
export function poolInfo() {
  const cores = navigator.hardwareConcurrency || 0;
  const isolated = !!self.crossOriginIsolated;
  if (!pool || pool.disposed) return { size: 0, threads: 0, cores, isolated };
  return { size: pool.size, threads: pool.threads, cores, isolated };
}

/* ---------------- 音轨解码（必须留在主线程） ---------------- */

export async function decodeAudio(file, durationHint, onProgress) {
  const buf = await file.arrayBuffer();
  onProgress?.({ phase: 'decode' });

  let duration = durationHint;
  if (!duration || !isFinite(duration)) duration = 0;

  // 用 OfflineAudioContext 直接把音轨重采样为 16kHz 单声道，避免多份大缓冲
  const frames = duration ? Math.ceil(duration * SR) : 0;
  if (frames) {
    const off = new OfflineAudioContext(1, frames, SR);
    const ab = await off.decodeAudioData(buf);
    return downmix(ab);
  }
  // 无法预知时长（如音频文件元数据缺失）：先解码再重采样
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
  const ab = await ctx.decodeAudioData(buf);
  const mono = downmix(ab);
  ctx.close();
  return mono;
}

function downmix(ab) {
  const n = ab.length;
  const out = new Float32Array(n);
  const ch = ab.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i];
  }
  if (ch > 1) for (let i = 0; i < n; i++) out[i] /= ch;
  return out;
}

/* ---------------- 识别 ---------------- */

// 主线程兜底引擎：只在 Worker 不可用时才动态加载
let mainEngine = null;
async function fallbackEngine() {
  if (!mainEngine) mainEngine = await import('./asr-engine.js');
  return mainEngine;
}

/**
 * 切段 → 多会话并行 → 按段序拼接。
 *
 * 为什么只把「已完成且连续」的前缀交给界面：各段是并发返回的，第 7 段可能
 * 比第 3 段先跑完。如果谁先完成就先把谁渲染出来，字幕会跳着往外冒。
 * 所以只在连续前缀延伸时才回调，界面看到的顺序永远是从头往后长。
 */
async function transcribePooled(pcm, { onProgress, wordTimestamps, onWords, shouldCancel }) {
  const segs = clampSegments(segmentAudio(pcm));
  const p = await ensurePool(onProgress);
  const total = segs.length;
  const totalSamples = pcm.length || 1;
  const byIndex = new Array(total).fill(null);
  const t0 = performance.now();
  let doneSamples = 0;

  const onSegDone = (task, words, done) => {
    byIndex[task.i] = words;
    doneSamples += (task.end - task.start);
    let end = 0;
    while (end < total && byIndex[end]) end++;
    const merged = [];
    for (let i = 0; i < end; i++) merged.push(...byIndex[i]);
    // 剩余时间按「已完成的音频秒数」推算。段的长度差别很大（17~29 秒），
    // 用段数推算会让进度条一冲一顿，用音频秒数才线性。
    const elapsed = (performance.now() - t0) / 1000;
    const etaSec = doneSamples > 0
      ? Math.max(0, (elapsed / doneSamples) * (totalSamples - doneSamples))
      : null;
    onWords?.(merged, done, total);
    onProgress?.({
      phase: 'transcribe',
      pct: Math.min(99, (doneSamples / totalSamples) * 100),
      seg: done, total,
      words: merged.length,
      etaSec,
    });
  };

  const results = await p.run(
    segs.map((s) => ({ start: s.start, end: s.end, pcm })),
    { wordTimestamps, onSegDone, shouldCancel }
  );
  const words = [];
  for (const r of results) if (r) words.push(...r);
  // 池子把「两次都失败、被跳过的段」挂在数组上带出来了。
  // 以前这些段是 null，被下面这行 `if (r)` 静默吃掉：字幕少一大截，日志一片安静，
  // 用户完全不知道为什么 17 分钟的视频只出前几分钟。
  const skipped = results.skipped || 0;
  // 全军覆没（比如会话全崩）不能假装成功：一段都没过就如实抛错，让上层走兜底路径。
  if (skipped && skipped >= total) {
    throw new Error(`全部 ${total} 段都识别失败，可能是设备内存不足或模型文件损坏`);
  }
  if (skipped) {
    console.warn(`[asr] 有 ${skipped}/${total} 段识别失败被跳过，字幕会出现缺口`, results.failed);
  }
  onProgress?.({ phase: 'transcribe', pct: 100, seg: total, total, words: words.length });
  // failedSegs 带出去，好让上层「只补这几段」用；skipped 只给个数量，定位不到具体缺口。
  return { words, cancelled: !!shouldCancel?.(), skipped, total, failedSegs: (results.failed || []).slice() };
}

/** 切段结果单独暴露：上层要把「上次缺了哪几段」换算回时间位置时需要它。 */
export function segmentsOf(pcm) {
  return clampSegments(segmentAudio(pcm));
}

/**
 * 只重跑指定的几段（补缺口专用）。
 *
 * 为什么值得单独做一条路：一份 17 分钟的音轨切出四十来段，上次只因设备内存紧
 * 崩了其中三、四段，用户点一次「重新识别」却要把整条音轨从头再算一遍 ——
 * 白花十几分钟，还多半会把同样的段再崩一次。这里只把缺的那几段送进池子。
 *
 * 段号以 segmentsOf(pcm) 的下标为准；pcm 必须与上次是同一份音频（同一切段算法、
 * 同一采样率），否则段号对不上。调用方负责保证这一点。
 *
 * @returns {Promise<{words:Array, covered:number[], missed:number[], total:number}>}
 */
export async function transcribeSegments(pcm, {
  indices = [], onProgress, wordTimestamps = true, shouldCancel,
} = {}) {
  const segs = segmentsOf(pcm);
  const total = segs.length;
  const want = [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < total)
    .sort((a, b) => a - b);
  if (!want.length) return { words: [], covered: [], missed: [], total };

  const p = await ensurePool(onProgress);
  const tasks = want.map((orig, k) => ({
    start: segs[orig].start, end: segs[orig].end, pcm, i: k,
  }));
  const results = await p.run(tasks, { wordTimestamps, shouldCancel });

  const words = [];
  const covered = [];
  const missed = [];
  want.forEach((orig, k) => {
    const r = results[k];
    if (Array.isArray(r) && r.length) { words.push(...r); covered.push(orig); }
    else missed.push(orig);
  });
  words.sort((a, b) => a.start - b.start);
  if (missed.length) {
    console.warn(`[asr] 补缺口：${missed.length}/${want.length} 段仍然没跑出来`, missed);
  }
  onProgress?.({ phase: 'transcribe', pct: 100, seg: want.length, total: want.length, words: words.length });
  return { words, covered, missed, total };
}

/**
 * @param {Float32Array} pcm 16kHz 单声道
 * @param {Object} o
 * @param {(info:Object)=>void} o.onProgress  段级进度
 * @param {(words:Array, seg:number, total:number)=>void} o.onWords  每段结束后的累积词
 * @param {boolean} o.wordTimestamps
 * @param {File} o.file  仅兜底路径需要：worker 路线失败时重新解码
 * @param {number} o.durationHint
 * @param {()=>boolean} o.shouldCancel
 * @param {string} o.modelId
 * @returns {Promise<{words:Array, cancelled:boolean}>}
 */
export async function transcribe(pcm, {
  onProgress, wordTimestamps = true, onWords, file, durationHint, shouldCancel, modelId: id,
} = {}) {
  if (id) setModel(id);

  // ── 主路径：多会话并行分片 ──
  if (!poolFailed) {
    try {
      return await transcribePooled(pcm, { onProgress, wordTimestamps, onWords, shouldCancel });
    } catch (e) {
      if (!e?.transport) throw e;   // 推理本身出错 → 如实上报，不做无谓重跑
      console.warn('[asr] 并行池不可用，改用单会话推理', e);
      poolFailed = true;
      dropPool();
      if (shouldCancel?.()) return { words: [], cancelled: true };
    }
  }

  if (!workerBroken) {
    try {
      await ensureModelLoaded(onProgress);
      // 把 PCM 所有权交给 worker，避免再复制一份几十 MB 的缓冲
      const buf = pcm.buffer;
      return await ask(
        { type: 'run', samples: pcm, wordTimestamps, modelId },
        { transfer: [buf], idleMs: RUN_IDLE_MS, onProgress, onWords, tag: 'run' }
      );
    } catch (e) {
      if (!e?.transport) throw e;   // 推理/装载本身出错 → 如实上报，不做无谓重跑
      console.warn('[asr] worker 不可用，改用主线程推理', e);
      // 关键：先把 Worker 干掉再回退，不然两份模型同时占内存会把主线程拖死
      killWorker();
      if (shouldCancel?.()) return { words: [], cancelled: true };
    }
  }
  const eng = await fallbackEngine();
  eng.resetCancel?.();   // 清掉上一次取消留下的标志，否则新任务会立刻被判定为取消
  // 缓冲已转交给 worker 时会被置空，这里重新解码一次
  let samples = pcm;
  if (!samples || samples.length === 0) {
    samples = await decodeAudio(file, durationHint, onProgress);
  }
  return eng.transcribe(samples, { onProgress, wordTimestamps, onWords, shouldCancel, modelId });
}

export function cancel() {
  pool?.cancel?.();
  if (worker) worker.postMessage({ type: 'cancel' });
  if (mainEngine) mainEngine.requestCancel?.();
}
