/* 激活核销的纯逻辑层 —— 不绑定存储实现。
 *
 * 线上跑在 Netlify（Blobs 当账本），本地跑在 server.js（JSON 文件当账本）。
 * 两条路共用这一份判定，避免「本地能过、线上被挡」这种只有上线才发现的分叉。
 *
 * 账本接口（由调用方注入）：
 *   ledger.isUsed(serial)        → truthy 表示已被核销
 *   ledger.markUsed(serial, meta) → 成功返回 true；已被别人抢先则返回 false
 *                                  （必须是原子操作，这是「一个码只能用一次」的唯一保证）
 */
import { ISSUED } from './issued.mjs';

const JSON_HEAD = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

export function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEAD });
}

/**
 * @param {{ method: string, body: any, ua: string }} input
 * @param {{ isUsed: Function, markUsed: Function }} ledger
 */
export async function handleActivate(input, ledger) {
  const method = String(input.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') return new Response('', { status: 204, headers: JSON_HEAD });
  if (method === 'GET') {
    // 健康检查：只报「服务在」和「发了多少个码」，不泄露清单内容
    return reply(200, { ok: true, service: 'echolingo-license', issued: ISSUED.size, 'single-use': true });
  }
  if (method !== 'POST') return reply(405, { ok: false, error: 'method' });

  const code = String(input.body?.code || '').trim();
  if (!code) return reply(400, { ok: false, error: 'no-code' });

  // 1) 先验签名：伪造的码根本进不了账本
  const v = input.verify ? input.verify(code) : { ok: false, serial: 0 };
  if (!v.ok) return reply(200, { ok: false, reason: 'invalid' });

  const serial = v.serial;

  // 2) 白名单：只有发出去的码才能激活（清单随代码部署，不依赖数据库初始化）
  if (!ISSUED.has(serial)) return reply(200, { ok: false, reason: 'unissued' });

  // 3) 核销：markUsed 必须原子。两个人同时提交同一个码，只有一个拿到 true。
  const already = await ledger.isUsed(serial);
  if (already) return reply(200, { ok: false, reason: 'used', at: already.at || null });

  const meta = { serial, at: new Date().toISOString(), ua: String(input.ua || '').slice(0, 160) };
  const won = await ledger.markUsed(serial, meta);
  if (!won) return reply(200, { ok: false, reason: 'used' });

  return reply(200, { ok: true, serial });
}

export { JSON_HEAD };
