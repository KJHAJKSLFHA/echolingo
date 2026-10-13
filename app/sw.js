// EchoLingo Service Worker
// 目标：应用外壳与模型文件一旦缓存，断网后仍可完整使用。
//
// ============================ 升级策略（重要） ============================
// 曾经踩过的坑：install 里 `await Promise.all(SHELL.map(cache.add))` 会等到
// 二十多个文件全部下载完才调用 skipWaiting()。外壳里含 1MB+ 的
// transformers.min.js 与词典分片，一旦某个请求慢或挂住，install 就一直停在
// "installing"，skipWaiting 永不执行、activate 永不触发 —— 新 SW 装不上，
// 页面由旧 SW 继续服务。
//
// 更糟的是「混搭」：旧 SW 对 js/css 走 stale-while-revalidate，会把新版
// app.js 先写进旧缓存，而 index.html 还是旧的，于是出现
// 「新 JS + 旧 HTML」→ 新 JS 找不到新元素，启动直接抛异常、页面卡死。
//
// 现在的做法：
//   1. install 里立刻 skipWaiting()，**不等待**任何下载（预缓存放后台 fire-and-forget）。
//      install 恒为瞬时完成 → 新版立刻接管 → activate 立刻清掉旧缓存。
//   2. 导航请求与页面代码（html/js/css/json）走 network-first：
//      在线时永远拿到同一版本的全套文件，从根上杜绝新旧混搭；离线才回落缓存。
//   3. 只有真正不可变的大文件（模型 onnx / wasm / 音视频 / 词典分片）走 cache-first。
// ==========================================================================

const VERSION = 'echolingo-v14';

// 需要离线可用的外壳。列表只影响「首次装完即可离线」的体验，
// 真正兜底的是运行时缓存：任何被请求过的资源都会自动进缓存。
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/i18n.js',
  './js/models.js',
  './js/segment.js',
  './js/asr.js',
  './js/asr-pool.js',
  './js/asr-engine.js',
  './js/asr-worker.js',
  './js/mt.js',
  './js/mt-worker.js',
  './js/dict.js',
  './js/subtitle.js',
  './js/subtitle-mask.js',
  './js/tts.js',
  './js/util.js',
];

const IMMUTABLE = /\.(onnx|wasm|spm|m4a|mp3|mp4|wav|bin)$/i;
const DICT_SHARD = /\/dict\/[a-z_]\.json$/i;

// 后台预缓存：不阻塞 install，失败也不影响可用性（运行时缓存会兜底）
async function precache() {
  const cache = await caches.open(VERSION);
  await Promise.all(SHELL.map(async (u) => {
    try {
      if (await cache.match(u, { ignoreSearch: true })) return;
      const res = await fetch(new Request(u, { cache: 'reload' }));
      if (res && res.ok && res.type === 'basic') await cache.put(u, res);
    } catch { /* 单个失败无所谓 */ }
  }));
}

self.addEventListener('install', () => {
  // 先接管，再慢慢填缓存 —— 顺序反了就会卡在 installing
  self.skipWaiting();
  precache().catch(() => {});
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('echolingo') && k !== VERSION).map((k) => caches.delete(k)),
    );
    await self.clients.claim();
    precache().catch(() => {});
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // 不做任何跨域处理

  const immutable = IMMUTABLE.test(url.pathname) || DICT_SHARD.test(url.pathname);
  const navigate = req.mode === 'navigate';

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);

    // —— 不可变大文件：命中即返回，绝不再走网络 ——
    if (immutable) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch {
        return new Response('离线且未缓存：' + url.pathname, {
          status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    }

    // —— 页面与代码：network-first，保证整站同版本 ——
    // cache:'no-cache' 是要紧的：它强制每次向服务器验证（配合 ETag 就是一次
    // 便宜的 304），而不是听信本地 HTTP 缓存的新鲜度判断。少了它，浏览器可能
    // 直接拿旧的 app.js 回来，于是「新 HTML + 旧 JS」或者
    // 「新 asr.js + 旧 asr-worker.js」这种混搭又会出现 —— 后者更隐蔽，
    // 因为 Worker 之间的消息协议只在代码里，对不上就是静默失效。
    try {
      const res = await fetch(new Request(req, { cache: 'no-cache' }));
      if (res && res.ok && res.type === 'basic') {
        const key = navigate ? './index.html' : req;
        cache.put(key, res.clone()).catch(() => {});
      }
      return res;
    } catch {
      const hit = await cache.match(navigate ? './index.html' : req, { ignoreSearch: true });
      if (hit) return hit;
      return new Response('离线且未缓存：' + url.pathname, {
        status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'ping') e.source?.postMessage({ type: 'pong', version: VERSION });
  if (e.data?.type === 'skip-waiting') self.skipWaiting();
});
