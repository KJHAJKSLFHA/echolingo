// 基准用：单个识别 Worker（每个 Worker 一份独立的 ORT session）
import { pipeline, env } from '../vendor/transformers.min.js';

const MODELS = new URL('../models/', import.meta.url).pathname;
const VENDOR = new URL('../vendor/', import.meta.url).pathname;

let asr = null;

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.useBrowserCache = false;
      env.useFSCache = false;
      env.localModelPath = MODELS;
      env.backends.onnx.wasm.wasmPaths = VENDOR;
      env.backends.onnx.wasm.numThreads = m.threads || 1;
      env.backends.onnx.wasm.proxy = false;
      const t0 = performance.now();
      asr = await pipeline('automatic-speech-recognition', m.modelId, {
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        device: 'wasm',
      });
      self.postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) });
      return;
    }
    if (m.type === 'run') {
      const t0 = performance.now();
      const out = await asr(m.samples, { return_timestamps: 'word', force_full_sequences: false });
      const words = (out.chunks || []).filter((c) => String(c.text || '').trim()).length;
      self.postMessage({
        type: 'done',
        task: m.task,
        ms: Math.round(performance.now() - t0),
        words,
        text: String(out.text || '').slice(0, 48),
      });
    }
  } catch (err) {
    self.postMessage({ type: 'error', task: m.task, message: String(err && err.message || err) });
  }
};
