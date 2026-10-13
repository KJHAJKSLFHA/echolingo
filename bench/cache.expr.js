const url = new URL('/models/whisper-base.en/onnx/encoder_model_quantized.onnx', location.origin).href;
const out = { url, hasController: !!navigator.serviceWorker.controller };
try {
  const reg = await navigator.serviceWorker.ready;
  out.swState = reg.active?.state;
} catch (e) { out.swState = 'ERR ' + e.message; }

const time = async (label, opts) => {
  const s = performance.now();
  const r = await fetch(url, opts);
  const b = await r.arrayBuffer();
  return {
    label,
    ms: Math.round(performance.now() - s),
    bytes: b.byteLength,
    age: r.headers.get('age'),
    cc: r.headers.get('cache-control'),
    corp: r.headers.get('cross-origin-resource-policy'),
  };
};

out.first = await time('first');
out.second = await time('second');
out.thirdForceCache = await time('third', { cache: 'force-cache' });

const m = await caches.match(url, { ignoreSearch: true });
out.swCacheHit = !!m;
const keys = await caches.keys();
out.cacheNames = keys;
for (const k of keys) {
  const c = await caches.open(k);
  const ks = await c.keys();
  out['cache_' + k] = {
    entries: ks.length,
    hasEncoderOnnx: ks.some((r) => r.url.includes('encoder_model_quantized')),
    sample: ks.slice(0, 10).map((r) => r.url.replace(location.origin, '')),
  };
}
return JSON.stringify(out, null, 1);
