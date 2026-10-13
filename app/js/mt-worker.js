// 机器翻译 Worker
//
// 为什么把它挪出主线程：
//   1. 翻译是 258 次串行推理，全在主线程跑会把界面按在那里动不了；
//   2. 句子之间彼此独立，几个 Worker 并行翻能直接砍掉大半等待时间。
//
// 注意这里是**逐句**推理（batch = 1），不是批处理 —— Marian 系模型对 padding
// 后的批输入会失控，短句被强制解码到 max_new_tokens，出现整段重复。并行的是
// 「多条句子」，不是「一个 batch」，所以没有这个问题。

import { pipeline, env } from '../vendor/transformers.min.js';

const MODELS_BASE = new URL('../models/', import.meta.url).pathname;
const VENDOR_BASE = new URL('../vendor/', import.meta.url).pathname;
const MODEL_ID = 'opus-mt-en-zh';

let translator = null;

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

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      if (translator) { self.postMessage({ type: 'ready' }); return; }
      configure(m.threads || 1);
      translator = await pipeline('translation', MODEL_ID, {
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.file) {
            self.postMessage({ type: 'progress', file: p.file, pct: p.total ? (p.loaded / p.total) * 100 : null });
          }
        },
      });
      self.postMessage({ type: 'ready' });
      return;
    }

    if (m.type === 'translate') {
      const r = await translator(m.text, { max_new_tokens: m.maxNew });
      const text = (Array.isArray(r) ? r[0] : r)?.translation_text || '';
      self.postMessage({ type: 'done', task: m.task, text });
    }
  } catch (err) {
    self.postMessage({ type: 'error', task: m.task, message: String(err?.message || err) });
  }
};
