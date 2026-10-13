// 机器翻译 Worker
//
// 为什么把它挪出主线程：
//   1. 翻译是几百次串行推理，全在主线程跑会把界面按在那里动不了；
//   2. 句子之间彼此独立，几个 Worker 并行翻能直接砍掉大半等待时间。
//
// 注意这里是**逐句**推理（batch = 1），不是批处理 —— Marian 系模型对 padding
// 后的批输入会失控，短句被强制解码到 max_new_tokens，出现整段重复。并行的是
// 「多条句子」，不是「一个 batch」，所以没有这个问题。
//
// ── 模型链 ──
//   英文内容只需要一个模型（en→zh）。西语没有现成的 es→zh 量化模型，
//   只能两跳：es→en 再用同一个 en→zh。所以这里接的是一**串**模型，
//   逐级套下去。链长 > 1 时主线程只会起一个 Worker（每个 Worker 要同时持有
//   两份权重），代价是吞吐减半 —— 但内存翻倍更难受。

import { pipeline, env } from '../vendor/transformers.min.js';

const MODELS_BASE = new URL('../models/', import.meta.url).pathname;
const VENDOR_BASE = new URL('../vendor/', import.meta.url).pathname;

let translators = [];        // 与 chain 一一对应

function configure(threads) {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.localModelPath = MODELS_BASE;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = VENDOR_BASE;
    env.backends.onnx.wasm.numThreads = threads;
    env.backends.onnx.wasm.proxy = false;
  }
}

async function loadChain(chain, threads) {
  configure(threads);
  const out = [];
  for (const id of chain) {
    out.push(await pipeline('translation', id, {
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file) {
          self.postMessage({
            type: 'progress', model: id, file: p.file,
            pct: p.total ? (p.loaded / p.total) * 100 : null,
          });
        }
      },
    }));
  }
  return out;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      const chain = m.chain || [];
      if (translators.length && chain.join('>') === m.chainKey) {
        self.postMessage({ type: 'ready' });
        return;
      }
      translators = await loadChain(chain, m.threads || 1);
      self.postMessage({ type: 'ready' });
      return;
    }

    if (m.type === 'translate') {
      let text = m.text;
      let mid = '';            // 链的第一跳输出（西语链里就是 es→en 的英文）
      // 逐级套：每一级的输出喂给下一级
      for (let i = 0; i < translators.length; i++) {
        const r = await translators[i](text, { max_new_tokens: m.maxNew });
        text = (Array.isArray(r) ? r[0] : r)?.translation_text || '';
        if (!text) break;      // 某一级吐空了就别再往下传，免得产出垃圾
        // 中间那一跳要交给界面当「英文翻译」用。链长只有一跳时（英语模式）
        // 第一跳的输出就是中文，不能当英文用，所以判一下长度。
        if (i === 0 && translators.length > 1) mid = text;
      }
      self.postMessage({ type: 'done', task: m.task, text, mid });
    }
  } catch (err) {
    self.postMessage({ type: 'error', task: m.task, message: String(err?.message || err) });
  }
};
