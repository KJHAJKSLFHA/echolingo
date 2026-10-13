// 语音识别模型清单
//
// 每个模型对应 models/<id>/ 下的一个目录（transformers.js 的本地模型布局）。
// 设置里只列出**确实存在于本机**的模型 —— 就算你删掉其中一个目录，
// 界面也不会留下一个「选了就报错」的选项。

export const ASR_MODELS = [
  {
    id: 'whisper-base.en',
    label: 'Whisper Base (EN)',
    sizeMB: 80,
    descKey: 'model.base.desc',
  },
  {
    id: 'whisper-tiny.en',
    label: 'Whisper Tiny (EN)',
    sizeMB: 44,
    descKey: 'model.tiny.desc',
  },
];

// 默认用 base：俚语、连读、口音词明显比 tiny 准，代价是识别时间约 1.5 倍。
export const DEFAULT_ASR_MODEL = 'whisper-base.en';

// transformers.js 在本地模型目录里会拉取的文件（相对 models/<id>/）
export const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'added_tokens.json',
  'normalizer.json',
  'special_tokens_map.json',
  'vocab.json',
  'merges.txt',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

export const modelsBase = () => new URL('../models/', import.meta.url).pathname;

/* ---------------- 「这个模型是不是已经在本机了」 ----------------

   模型文件下载一次要几分钟，所以「要不要为它开几条并发连接去抢带宽」
   这件事必须先问一句「是不是首次」。判断依据就是这两个 localStorage 标记：
   装载成功过一次就记上，下次直接走缓存路径。

   放在这里而不是 app.js，是因为主线程（决定要不要预取）和 asr.js
   （真正建池子）都要用同一个键名 —— 两边各写一份字符串迟早会写岔。 */

export const LS_ASR_CACHED = 'echolingo.asrCached';
export const LS_MT_CACHED = 'echolingo.mtCached';

/** localStorage 读不出来（隐私模式等）时一律当「已缓存」：
 *  宁可不预取（慢一点但一定对），也不要重复下载几十 MB。 */
export function isModelCached(key) {
  try { return !!localStorage.getItem(key); } catch { return true; }
}

export function markModelCached(key) {
  try { localStorage.setItem(key, '1'); } catch { /* 忽略 */ }
}

export function modelMeta(id) {
  return ASR_MODELS.find((m) => m.id === id) || null;
}

/** 模型在界面上的显示名，找不到就退回 id */
export function modelLabel(id) {
  return modelMeta(id)?.label || String(id || '');
}

/** 本机实际存在的模型 id，顺序与 ASR_MODELS 一致 */
export async function availableASRModels() {
  const base = modelsBase();
  const found = await Promise.all(ASR_MODELS.map(async (m) => {
    try {
      const res = await fetch(`${base}${m.id}/config.json`, { cache: 'force-cache' });
      return res.ok ? m.id : null;
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}

/** 把「设置里存的值」解析成真正可用的模型 id */
export async function resolveASRModel(preferred) {
  const list = await availableASRModels();
  if (!list.length) return null;
  if (preferred && list.includes(preferred)) return preferred;
  return list.includes(DEFAULT_ASR_MODEL) ? DEFAULT_ASR_MODEL : list[0];
}
