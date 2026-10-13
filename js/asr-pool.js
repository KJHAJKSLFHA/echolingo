// 并行识别池
//
// ── 为什么需要它 ──
//
// 用真实语音在 10 核机器上实测 whisper-base(q8)：
//
//   一段音频不管长 5 秒还是 29 秒，都要付一次约 1.6 秒的「30 秒窗口编码器」
//   固定成本（whisper 的特征提取器永远按 30 秒窗口算），可变部分只有
//   约 0.06 秒/秒音频。也就是说 **总时间几乎正比于段数**。
//
//   而多线程对固定成本几乎没用 —— 线程扩展效率只有五成上下：
//
//     1 会话 × 1 线程   RTF 0.205
//     1 会话 × 4 线程   RTF 0.091     （2.25 倍，不是 4 倍）
//     4 会话 × 2 线程   RTF 0.058     ← 比 1×4 再快 1.6 倍
//     6 会话 × 1 线程   RTF 0.063
//
//   所以正确做法是**多个会话并行分片**：把切好的段分给几个 Worker 同时跑。
//   段与段本来就不重叠，并行拼出来的词序列与串行逐段跑完全一致，
//   准确度零损失 —— 这是纯粹的吞吐优化。
//
// ── 代价与约束 ──
//
//   · 每个会话要自己持有一份权重（base 约 77MB）＋ wasm 堆，粗算 260MB。
//     所以池子大小必须看设备脸色，不能见到多核就开满。
//   · 装载必须**先起一个、再起其余**：同一批模型文件被 N 个会话并发请求时
//     浏览器不会自动合并，首次使用会把几十 MB 下 N 遍。
//   · 首次那 76MB 不能交给 transformers 自己慢慢拉 —— 实测本站**单连接**
//     稳定在 400KB/s 左右，而 8 条并发能到 1.1MB/s。见 prefetchBig()。
//
// ⚠️ 这个模块**不要** import asr-engine.js：那会把 1MB 的 transformers.min.js
//    拽进主线程首屏。线程数由这里算好后通过消息交给 Worker，
//    与 Worker 内 defaultThreads() 的取值保持同一套规则即可。

const TASK_TIMEOUT_MS = 180000;   // 单段超过 3 分钟没回包 → 这个会话算卡死

const MODELS_BASE = new URL('../models/', import.meta.url).pathname;

// 只有这两个文件值得单独开连接预取：合计 76MB，占首次下载的九成以上。
// 其余十几个都是 KB 级，transformers 自己拉一下就过去了。
const BIG_FILES = [
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

/**
 * 用几条**并发连接**把两个大文件一次性拉进浏览器缓存。
 *
 * 为什么要单独干这一票（实测数据，改之前先量一遍）：
 *
 *   本站单连接稳定      ≈ 400 KB/s     → 76MB 要 190 秒
 *   4 条并发聚合        ≈ 600 KB/s
 *   8 条并发聚合        ≈ 1.1 MB/s
 *   本机网络上限（淘宝镜像） 3.5 MB/s  （所以瓶颈在站点这一侧，不在用户）
 *
 * transformers 是一个文件一个文件按顺序拉的，等于全程只有一条连接在跑，
 * 白白把可用的并发度浪费掉。这里先把 encoder / decoder 两条连接同时铺开、
 * 各自把响应体读到尾（读完才写进缓存），后面每个会话取到的都是缓存：
 * 既不重复下载，也不再被单连接限速卡住。
 *
 * 失败**不算致命**：直接放行，让 transformers 走它原来的老路 ——
 * 预取只是加速，不是必经之路。
 *
 * @param {string} modelId
 * @param {(p:Object)=>void} [onProgress] 上报 {phase:'load', file, received, totalBytes, pct}
 */
async function prefetchBig(modelId, onProgress, isDisposed) {
  let received = 0;
  let arrived = 0;             // 已经拿到响应头的文件数
  let totalBytes = 0;          // 只有两个都到齐才是真总数
  const t0 = Date.now();

  await Promise.all(BIG_FILES.map(async (rel) => {
    const url = `${MODELS_BASE}${modelId}/${rel}`;
    const name = rel.split('/').pop();
    // force-cache：已经缓存过就直接拿本地的，不再往服务器要
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`${name} 返回 ${res.status}`);
    totalBytes += Number(res.headers.get('content-length')) || 0;
    arrived++;
    // 两个响应头到齐之前**不报百分比**：这时 totalBytes 只算了先到的那一个，
    // 照它算会先冲到 100% 再掉回 30%，进度条来回跳比不动还难看。
    // 那几百毫秒里只说「加载识别模型…」，MB 数照报（它永远是真的）。
    const known = arrived === BIG_FILES.length;

    const reader = res.body?.getReader?.();
    if (!reader) { await res.arrayBuffer(); return; }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (isDisposed?.()) { try { await reader.cancel(); } catch {} return; }
      received += value.byteLength;
      onProgress?.({
        phase: 'load',
        file: name,
        received,
        totalBytes: known ? totalBytes : 0,
        // 用字节算总进度：两个文件并发，按「哪个文件下到几成」显示会来回跳
        pct: known && totalBytes ? Math.min(100, (received / totalBytes) * 100) : null,
      });
    }
  }));

  console.info(`[asr-pool] 并行预取完成：${(received / 1048576).toFixed(1)}MB`
    + ` / ${Date.now() - t0} ms` + `（并发 ${BIG_FILES.length} 条连接）`);
  return received;
}


/** 设备画像：决定开几个会话、每个会话几线程 */
export function pickPoolShape(segCount) {
  const hc = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 0;          // GB；Safari/Firefox 没有这个字段
  const isolated = !!self.crossOriginIsolated;      // 没有它就没有 SharedArrayBuffer

  // 每个会话一份权重，内存太小的设备不能开多
  let byMem = 4;
  if (mem && mem <= 4) byMem = 2;
  if (mem && mem <= 2) byMem = 1;

  // 留一个核给界面（音轨解码、字幕渲染都还在主线程）
  const cores = Math.max(1, hc - 1);

  const size = Math.max(1, Math.min(4, byMem, Math.floor(cores / 2) || 1, segCount));
  const threads = !isolated ? 1
    : (size === 1 ? Math.min(4, cores) : 2);

  return { size, threads, cores, mem, isolated };
}

/**
 * 建一个并行识别池。池子常驻，切换模型或换线程数时整体重建。
 * @param {{modelId:string, size:number, threads:number, prefetch?:boolean}} o
 * @param {boolean} [o.prefetch] 是否为首次下载开并发预取（已缓存就别白读一遍 76MB）
 */
export function createASRPool({ modelId, size, threads, prefetch = false }) {
  const slots = [];          // { w, idx, busy }
  let disposed = false;
  let seq = 0;

  function spawn(idx) {
    // 带版本参数起 Worker：脚本本身与它 import 的 asr-engine/segment 是两套
    // 独立的模块图，浏览器 HTTP 缓存有可能只更新了其中一半。消息协议只写在
    // 代码里，新旧对不上不会报错，只会静默失效 —— 所以这里强制换个 URL。
    const ver = self.__ECHOLINGO_VER__ || '';
    const url = new URL('./asr-worker.js', import.meta.url);
    if (ver) url.searchParams.set('v', ver);
    const w = new Worker(url, { type: 'module' });
    const slot = { w, idx, busy: false };
    slots.push(slot);
    return slot;
  }

  function drop(slot) {
    try { slot.w.terminate(); } catch {}
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
  }

  /** 让一个会话把模型读进来 */
  function loadSlot(slot, onProgress) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const onMsg = (ev) => {
        const m = ev.data || {};
        if (m.type === 'ready') { off(); resolve({ ms: Date.now() - t0, threads: m.threads }); }
        else if (m.type === 'progress') onProgress?.(m);
        else if (m.type === 'error') { off(); reject(new Error(m.message || '装载失败')); }
      };
      const off = () => slot.w.removeEventListener('message', onMsg);
      slot.w.addEventListener('message', onMsg);
      slot.w.addEventListener('error', () => { off(); reject(new Error('识别线程启动失败')); });
      slot.w.postMessage({ type: 'load', modelId, threads });
    });
  }

  /** 装载全部会话。第一个单独装（负责真正下载），其余并行装（命中缓存）。 */
  async function loadAll(onProgress) {
    for (const s of slots) drop(s);
    const t0 = Date.now();

    // 第一步：首次下载时先用并发连接把两个大文件抢下来。
    // 成功之后下面的会话装载全部命中缓存 —— 既快，也彻底杜绝「N 个会话各下一遍」。
    // 已经缓存过就不做：白读 76MB 只为报进度，纯属浪费。
    let ready = false;
    if (prefetch) {
      try {
        await prefetchBig(modelId, onProgress, () => disposed);
        ready = true;
      } catch (e) {
        console.warn('[asr-pool] 并行预取失败，交回 transformers 自己下载', e);
      }
      if (disposed) return [];
    }

    const first = spawn(0);
    // 预取成功就不用再报文件级进度了（那 76MB 已经下完，接下来是读缓存），
    // 否则保持原来的行为，让用户至少看到在动
    const r0 = await loadSlot(first, ready ? null : onProgress);
    if (disposed) return [];
    const rest = [];
    for (let i = 1; i < size; i++) rest.push(spawn(i));
    const rs = await Promise.all(rest.map((s) => loadSlot(s, null).catch((e) => {
      // 多开一个会话失败（多半是内存不够）不算致命：把它去掉，
      // 用剩下的会话继续跑，只是并行度低一点。
      console.warn('[asr-pool] 会话装载失败，已移除', e);
      drop(s);
      return null;
    })));
    const ok = [r0, ...rs.filter(Boolean)];
    console.info(`[asr-pool] 并行识别已就绪：${ok.length} 个会话 × ${threads} 线程`
      + `（装载 ${Date.now() - t0} ms${prefetch ? '，含并发预取' : ''}`
      + `；hardwareConcurrency=${navigator.hardwareConcurrency}`
      + `，crossOriginIsolated=${self.crossOriginIsolated}）`);

    // 让每个会话先空跑一次：ORT 的第一次推理要分配内存池、编译 kernel，
    // 这段「开机税」不在这里交掉，就会原封不动落到用户点下识别之后的第一段上，
    // 白白多等两三秒。用 1 秒静音段预热即可 —— 编码器照样按 30 秒窗口跑一遍，
    // 该热的都热到了，解码器因为立刻遇到 EOS 几乎不花时间。
    const warmT0 = Date.now();
    const warmPcm = new Float32Array(16000);
    await Promise.all(slots.slice().map((slot, i) => runSeg(
      slot,
      { i: -1 - i, start: 0, end: warmPcm.length, pcm: warmPcm, sec: 1 },
      true
    ).catch(() => {})));
    console.info(`[asr-pool] 会话预热完成 ${Date.now() - warmT0} ms`);
    return ok;
  }

  /** 把一段音频交给一个会话 */
  function runSeg(slot, task, wordTimestamps) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(Object.assign(new Error('单段识别超时'), { stale: true })); }, TASK_TIMEOUT_MS);
      const onMsg = (ev) => {
        const m = ev.data || {};
        if (m.task !== task.i) return;
        if (m.type === 'seg-done') { off(); resolve(m); }
        else if (m.type === 'error') { off(); reject(new Error(m.message || '识别失败')); }
      };
      const off = () => { clearTimeout(timer); slot.w.removeEventListener('message', onMsg); slot.busy = false; };
      slot.w.addEventListener('message', onMsg);
      const slice = task.pcm.slice(task.start, task.end);
      slot.busy = true;
      slot.w.postMessage(
        { type: 'seg', task: task.i, samples: slice, offsetSec: task.start / 16000, wordTimestamps, modelId },
        [slice.buffer]
      );
    });
  }

  /**
   * 并行跑完所有段。
   * @param {Array<{start:number,end:number,pcm:Float32Array,sec:number}>} tasks
   * @param {Object} o
   * @param {boolean} o.wordTimestamps
   * @param {(task:Object, words:Array, done:number, total:number)=>void} o.onSegDone
   * @param {()=>boolean} o.shouldCancel
   * @returns {Promise<Array<Array>>} 与 tasks 同序的词数组
   */
  async function run(tasks, { wordTimestamps = true, onSegDone, shouldCancel } = {}) {
    if (!slots.length) throw new Error('识别池为空');
    const out = new Array(tasks.length).fill(null);
    // 派发顺序要同时顾两件事：
    //
    //   · 右侧只渲染「已完成且连续」的前缀（见 asr.js 的 transcribePooled），
    //     而纯粹的「最长的先派」会把时序最靠前的几段排到队尾 —— 前面不完成，
    //     后面跑完多少段都不显示。实测 14 分钟视频：后台 17 秒时已经跑完 11 段，
    //     右侧却一直是「已得到 0 个词」，第一句等到 18 秒才出现。
    //   · 尾部空闲要靠「长的先派」压掉。
    //
    // 折中：最前面 slots.length 段按时序先派（保证连续前缀立刻推进、第一句最快出），
    // 剩下的仍然长的先派。只把最前面这一小撮的顺序摆正，对整体工期影响很小。
    const ordered = tasks.map((t, i) => ({ ...t, i }));
    const headCount = Math.max(1, slots.length);
    const queue = ordered.slice(0, headCount)
      .concat(ordered.slice(headCount).sort((a, b) => (b.end - b.start) - (a.end - a.start)));
    let doneCount = 0;
    let fatal = null;
    const retried = new Set();

    const consume = async (slot) => {
      while (queue.length) {
        if (disposed || fatal || shouldCancel?.()) return;
        const task = queue.shift();
        try {
          const r = await runSeg(slot, task, wordTimestamps);
          if (disposed) return;
          out[task.i] = r.cancelled ? [] : (r.words || []);
          doneCount++;
          onSegDone?.(task, out[task.i], doneCount, tasks.length);
        } catch (e) {
          if (disposed || fatal) return;
          // 会话卡死或崩了：把这个会话丢掉，任务退回队列交给别人。
          // 还是不行就只能放弃 —— 别让一个坏段把整条音轨拖住。
          if (!retried.has(task.i)) {
            retried.add(task.i);
            console.warn('[asr-pool] 单段失败，换会话重试一次', task.i, e);
            if (e.stale) drop(slot);
            queue.push(task);
            if (!slots.length) { fatal = e; return; }
            if (e.stale) return;      // 这个 slot 已经没了，退出它的循环
          } else {
            fatal = e;
            return;
          }
        }
      }
    };

    await Promise.all(slots.slice().map(consume));
    if (fatal) throw fatal;
    return out;
  }

  /** 让正在跑的那一段跑完就丢弃结果（单段不可中断，最坏等一段的时间） */
  function cancel() {
    for (const s of slots) {
      try { s.w.postMessage({ type: 'cancel' }); } catch {}
    }
  }

  function terminate() {
    disposed = true;
    for (const s of slots.slice()) drop(s);
  }

  return {
    get size() { return slots.length; },
    requestedSize: size,
    threads,
    modelId,
    loadAll,
    run,
    cancel,
    terminate,
    get disposed() { return disposed; },
  };
}
