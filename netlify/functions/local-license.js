/* 本地开发用的激活核销路由（server.js 与 desktop/site-server.js 共用）。
 *
 * 与线上 netlify/functions/activate.mjs 走同一份判定逻辑（license-core.mjs），
 * 差别只在账本：线上是 Netlify Blobs，本地是 .local/license-used.json。
 * 这样「一个码只能用一次」在本地就能验证，不必先部署才发现问题。
 *
 * 注意：这是 CommonJS，因为 netlify/functions/*.mjs 是 ESM，通过动态 import 调用。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PREFIX = '/api/license/';

function ledgerFile(root) {
  return path.join(root, '.local', 'license-used.json');
}

function readLedger(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

function writeLedger(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 先写临时文件再 rename：中途被杀不会留下半截 JSON 把所有码判成未用
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/* 读请求体，限制在 8KB —— 激活码这辈子不会超过 64 字节。 */
function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} root 项目根目录（账本写在 <root>/.local/ 下）
 * @returns {boolean} 是否已处理
 */
function handleLicenseApi(req, res, root) {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { return false; }
  if (!pathname.startsWith(PREFIX)) return false;

  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
    res.end();
    return true;
  }

  const file = ledgerFile(root);
  // ledger 接口按「已用标记」取舍；本地没有并发压力，普通读写足够
  const ledger = {
    async isUsed(serial) {
      const db = readLedger(file);
      return db[String(serial)] || null;
    },
    async markUsed(serial, meta) {
      const db = readLedger(file);
      if (db[String(serial)]) return false;
      db[String(serial)] = meta;
      writeLedger(file, db);
      return true;
    },
  };

  (async () => {
    const body = method === 'POST' ? await readBody(req) : null;
    const { handleActivate } = await import('./license-core.mjs');
    const { createRequire } = await import('node:module');
    const require2 = createRequire(__filename);
    const LIC = require2('../../app/js/license.js');
    const out = await handleActivate(
      { method, body, ua: req.headers['user-agent'] || '', verify: LIC.check },
      ledger,
    );
    const text = await out.text();
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(text);
  })().catch((e) => {
    send(res, 500, { ok: false, error: 'local-license', detail: String(e && e.message || e) });
  });

  return true;
}

module.exports = { handleLicenseApi, ledgerFile };
