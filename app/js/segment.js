// 音轨切段（纯计算，零依赖）
//
// 单独成文件的原因：主线程要用它来切段，但主线程**不能**因此把
// vendor/transformers.min.js（1MB）拉进首屏。这个模块只做数组运算。

export const SR = 16000;

/* ---------------- 静音感知切段 ----------------

   ⚠️ 这里有一个必须守住的硬约束：**每一段都必须短于 30 秒。**

   whisper 的特征提取器窗口固定 30 秒（n_samples = 480000），
   vendor/transformers.min.js 里的实现是：

       e.length > s ? (console.warn(...), n = e.slice(0, s)) : (n = new Float32Array(s), n.set(e))

   多出来的音频是**静默裁掉**的，不会报错、也不会自动分块
   （除非显式传 chunk_length_s，我们没有传）。
   所以之前按 42 秒切段时，每段只有前 30 秒被识别，后面 12 秒凭空消失，
   长视频的表现就是「少句子、上下文接不上、听起来识别错了」。
------------------------------------------------ */

export const WHISPER_WINDOW_SEC = 30;   // whisper 的物理上限
export const MAX_SEG_SEC = 29;          // 实际使用的上限。留 1 秒余量就够：
                                        // 窗口是 480000 采样（30.0 秒），29 秒 = 464000，
                                        // 永远不会被那行 slice(0, s) 静默裁掉。
                                        // 每段都要付一次「30 秒窗口编码器」的固定钱，
                                        // 所以段数越少总时间越短，能长就长。

/** 静音感知切段（每段必须 < 30 秒，见上方注释）
 *
 *  实测数据（10 核，4 会话 × 2 线程并行）：每段有约 1.6 秒固定开销，
 *  加上约 0.06 秒/秒音频的可变开销。也就是说 **总时间几乎正比于段数**，
 *  段长本身反而不太重要。过去只挑「最安静的点」下刀，刀口常年落在
 *  15-20 秒处，平白多切出三成段数 —— 这是慢的一个重要来源。
 *
 *  现在评分同时看两件事：这里安静吗、这里够不够靠后。
 *  `tailBias` 就是「靠到最末尾」愿意用多少安静度去换。
 */
export function segmentAudio(pcm, { frameMs = 20, minSec = 17, maxSec = MAX_SEG_SEC, tailBias = 0.45 } = {}) {
  const N = pcm.length;
  const maxSamples = Math.round(maxSec * SR);
  const minSamples = Math.round(minSec * SR);
  if (N <= maxSamples) return [{ start: 0, end: N }];

  const hop = Math.round((frameMs / 1000) * SR);
  const frames = Math.floor(N / hop);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i += 4) { const v = pcm[base + i]; s += v * v; }
    rms[f] = Math.sqrt(s / (hop / 4));
  }
  // ±3 帧局部均值，免得被单帧毛刺骗到
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f - 3), b = Math.min(frames - 1, f + 3);
    let s = 0;
    for (let k = a; k <= b; k++) s += rms[k];
    smooth[f] = s / (b - a + 1);
  }

  const segs = [];
  let cursor = 0;

  while (N - cursor > maxSamples) {
    const loF = Math.min(frames - 1, Math.round((cursor + minSamples) / hop));
    const hiF = Math.min(frames - 1, Math.round((cursor + maxSamples) / hop));
    if (hiF <= loF) {
      segs.push({ start: cursor, end: Math.min(N, cursor + maxSamples) });
      cursor += maxSamples;
      continue;
    }
    let avg = 0;
    for (let f = loF; f <= hiF; f++) avg += smooth[f];
    avg /= (hiF - loF + 1) || 1;

    let best = hiF, bestScore = Infinity;
    for (let f = loF; f <= hiF; f++) {
      const quiet = avg > 0 ? smooth[f] / avg : 0;   // 0 最安静，1 等于区间均值
      const pos = (f - loF) / ((hiF - loF) || 1);    // 0 靠前，1 靠后
      const score = quiet - tailBias * pos;          // 越靠后越省一段的钱
      if (score < bestScore) { bestScore = score; best = f; }
    }
    const cut = Math.min(best * hop, cursor + maxSamples, N);
    if (cut <= cursor) break;
    segs.push({ start: cursor, end: cut });
    cursor = cut;
  }

  if (cursor < N) {
    const tail = N - cursor;
    const prev = segs[segs.length - 1];
    // 收尾别留一个「几秒钟的小尾巴」：它一样要付 1.6 秒固定开销，
    // 性价比极低。能并进上一段就并，并进去超长就把最后两段均分。
    if (prev && tail < 8 * SR) {
      const merged = N - prev.start;
      segs.pop();
      if (merged <= maxSamples) {
        segs.push({ start: prev.start, end: N });
      } else {
        const half = prev.start + Math.round(merged / 2);
        segs.push({ start: prev.start, end: half });
        segs.push({ start: half, end: N });
      }
    } else {
      segs.push({ start: cursor, end: N });
    }
  }
  return segs;
}

/** 兜底：把任何超过 MAX_SEG_SEC 的段硬切成安全长度。
 *  segmentAudio 理论上不会越界，这里是防止以后有人改参数时
 *  又把超长音频喂给 whisper —— 一旦发生就是整段后半截静默丢失。 */
export function clampSegments(segs) {
  const cap = Math.round(MAX_SEG_SEC * SR);
  const out = [];
  for (const s of segs) {
    if (s.end - s.start <= cap) { out.push(s); continue; }
    for (let p = s.start; p < s.end; p += cap) out.push({ start: p, end: Math.min(s.end, p + cap) });
  }
  return out;
}
