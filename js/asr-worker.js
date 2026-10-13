// 语音识别 Worker
//
// 把 whisper 推理搬到独立线程，主线程在识别期间依然能播放、滚动、查词。
// 主线程通过消息驱动：load / seg / run / cancel。
//
// 两种识别方式：
//   · `seg` —— 只跑**一段**（并行分片用）。主线程把音频切成段，交给多个
//     同样的 Worker 同时跑，这是当前的主路径，见 asr-pool.js。
//   · `run` —— 跑**整条**音轨（内部自己切段、逐段跑）。只在并行池起不来时兜底。

import { loadASR, transcribe, transcribeSegment, resetCancel, loadedModelId } from './asr-engine.js';

let cancelled = false;
let modelId = null;
let threads = 0;

postMessage({ type: 'boot' });

self.onmessage = async (e) => {
  const msg = e.data || {};
  const phase = msg.type;
  try {
    if (msg.type === 'cancel') {
      cancelled = true;
      return;
    }

    if (msg.type === 'load') {
      modelId = msg.modelId || modelId;
      if (msg.threads) threads = msg.threads;
      await loadASR((p) => postMessage({ type: 'progress', ...p }), modelId, threads || undefined);
      postMessage({ type: 'ready', modelId: loadedModelId(), threads });
      return;
    }

    // ── 并行分片：只跑一段，不做切段 ──
    if (msg.type === 'seg') {
      cancelled = false;
      resetCancel();                       // 清掉上一次取消留下的标志
      modelId = msg.modelId || modelId;
      if (msg.threads) threads = msg.threads;
      const samples = new Float32Array(msg.samples);
      const offset = msg.offsetSec || 0;
      const words = await transcribeSegment(samples, {
        wordTimestamps: !!msg.wordTimestamps,
        modelId,
        threads: threads || undefined,
      });
      if (cancelled) {
        postMessage({ type: 'seg-done', task: msg.task, cancelled: true, words: [] });
        return;
      }
      // 段内相对时间在这里一次性加上段偏移，主线程拿到即可直接拼接
      for (const w of words) { w.start += offset; w.end += offset; }
      postMessage({ type: 'seg-done', task: msg.task, words, cancelled: false });
      return;
    }

    // ── 串行兜底：跑整条音轨 ──
    if (msg.type === 'run') {
      cancelled = false;
      resetCancel();
      modelId = msg.modelId || modelId;
      if (msg.threads) threads = msg.threads;
      // 直接用主线程**转移**过来的那块缓冲，不再拷第二份。
      // asr.js 发这条消息时带的是 transfer，所有权已经在这里；再
      // new Float32Array(...) 等于把几十 MB（一小时视频约 230MB）多复制一遍、
      // 峰值内存翻倍，而主线程那份照样已经失效 —— 两边的代价都白付了。
      // 兜底路径本就靠「缓冲为空就重新解码」，不受影响。
      const samples = msg.samples;
      const { words, cancelled: wasCancelled } = await transcribe(samples, {
        modelId,
        threads: threads || undefined,
        wordTimestamps: !!msg.wordTimestamps,
        onProgress: (p) => postMessage({ type: 'progress', ...p }),
        onWords: (all, seg, total) => postMessage({ type: 'words', words: all, seg, total }),
        shouldCancel: () => cancelled,
      });
      postMessage({ type: 'done', words, cancelled: wasCancelled });
    }
  } catch (err) {
    // phase 告诉主线程：这是「装载」失败（Worker 这条路走不通）还是
    // 「识别」失败（模型/音频本身的问题）。两者处理方式不同。
    postMessage({ type: 'error', phase, task: msg.task, message: String(err?.message || err) });
  }
};
