'use strict';

// 桌面版内置的静态服务器。
//
// 为什么桌面版还需要一个服务器（而不是直接 file:// 或自定义协议）：
//
//   1. onnxruntime 的 wasm 后端要靠 SharedArrayBuffer 才能开多线程，而浏览器
//      只在 `crossOriginIsolated === true` 时才放开它 —— 条件就是文档响应带
//      COOP/COEP 头。file:// 给不了响应头，自定义协议在 Chromium 里也拿不到
//      跨源隔离。http://127.0.0.1 是「潜在可信来源」，既能发头、又能注册
//      Service Worker，是唯一两全的选择。
//   2. 端口必须**固定**：localStorage / IndexedDB（收藏夹）和 Service Worker
//      缓存都是按来源（scheme+host+port）隔离的。端口一变，用户的收藏就没了。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// 链接导入的取流接口（/api/url/*）。跟着桌面版走，网页版也能跨域调它。
let handleUrlApi = null;
for (const p of ['../url-import.js', '../../url-import.js', './url-import.js']) {
  try { ({ handleUrlApi } = require(p)); break; } catch { /* 换下一个位置 */ }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.spm': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// 体积大且永不变化：模型、wasm 运行时、示例音视频
const IMMUTABLE = /\.(onnx|wasm|spm|bin|m4a|mp3|mp4|webm|wav|mov|mkv)$/i;

function createSiteServer(root) {
  const ROOT = path.resolve(root);

  return http.createServer((req, res) => {
    // 取流接口要在 405 判断之前接住：它还要处理 OPTIONS 预检
    if (handleUrlApi && req.url && req.url.split('?')[0].startsWith('/api/url/')) {
      let apiPath = '/';
      try {
        apiPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname || '/');
      } catch { /* 交给接口回 404 */ }
      if (handleUrlApi(req, res, apiPath)) return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      return res.end('Method Not Allowed');
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname || '/');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Bad Request');
    }

    // 归一化后必须仍落在 ROOT 内，挡住 ../ 这类穿越
    const rel = path.normalize(pathname).replace(/^([/\\])+/, '');
    let file = path.resolve(ROOT, rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }

    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) {
        // 拼上 index.html 后必须重新 stat —— 否则下面 !st 恒真，目录永远 404
        const idx = path.join(file, 'index.html');
        return fs.stat(idx, (e2, st2) => {
          if (e2 || !st2 || !st2.isFile()) return notFound(res, pathname);
          send(res, idx, st2, req);
        });
      }
      if (err || !st || !st.isFile()) {
        // 单页应用回退：只在「看起来是页面导航」时才回 index.html。
        // 模型文件缺失必须老老实实 404 —— 回一段 HTML 会让 transformers
        // 报一个完全看不懂的解析错误，排查时很痛苦。
        const wantsHtml = String(req.headers.accept || '').includes('text/html');
        const hasExt = path.extname(pathname) !== '';
        if (wantsHtml && !hasExt) {
          const fallback = path.join(ROOT, 'index.html');
          return fs.stat(fallback, (e2, st2) => {
            if (e2 || !st2) return notFound(res, pathname);
            send(res, fallback, st2, req);
          });
        }
        return notFound(res, pathname);
      }
      send(res, file, st, req);
    });
  });
}

function notFound(res, pathname) {
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end('Not Found: ' + pathname);
}

function send(res, file, st, req) {
  const ext = path.extname(file).toLowerCase();
  const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs || 0).toString(16)}"`;

  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    // 这三行是本文件存在的理由，见文件头注释
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': IMMUTABLE.test(ext) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);   // 304 不带 body
    return res.end();
  }

  headers['Content-Length'] = st.size;
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(file);
  stream.on('error', () => { try { res.end(); } catch {} });
  stream.pipe(res);
}

module.exports = { createSiteServer };
