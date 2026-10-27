/* 激活码核销（Netlify 适配层）—— 一个码只能用一次。
 *
 * 为什么需要服务端：app/js/license.js 是纯离线 HMAC 校验，客户端自己就算得出签名，
 * 同一个码能被无限次重复激活。要「单次有效」就必需一处权威账本，
 * 记录哪个序列号已经被用掉。账本在这里是 Netlify Blobs。
 *
 * 判定逻辑全在 license-core.mjs，与 server.js 的本地实现共用同一份，
 * 避免「本地能过、线上被挡」这种只有部署后才发现的分叉。
 *
 * 数据布局：
 *   lic/used/<serial> → 核销标记；写入用 onlyIfNew，并发下只有一个能成功
 *   （已发行清单不放 Blobs，而是随代码打包成 issued.mjs，见那里的注释）
 */
import { getStore } from '@netlify/blobs';
import { handleActivate } from './license-core.mjs';
// 静态导入而不是 createRequire：函数会被 esbuild 打成单文件，
// 运行期再按相对路径 require 会在打包后失效（离线校验逻辑必须打进包里）。
import LIC from '../../app/js/license.js';

const STORE = 'lic';

/* Blobs 账本实现。
 * markUsed 必须原子：setJSON(..., { onlyIfNew: true }) 在键已存在时会抛错，
 * 判定「抛错 = 刚被别人抢走」，因此两个人同时提交同一个码只有一个拿到 ok。 */
function blobsLedger() {
  const store = getStore(STORE);
  return {
    async isUsed(serial) {
      try {
        return await store.get(`used/${serial}`, { type: 'json' });
      } catch (e) {
        return null;
      }
    },
    async markUsed(serial, meta) {
      try {
        const r = await store.setJSON(`used/${serial}`, meta, { onlyIfNew: true });
        // 关键：onlyIfNew 在键已存在时【不抛异常】，而是正常返回 { modified: false }。
        // 早先只按「抛错 = 被抢走」判定，导致每个码都能无限次重复激活（线上实测踩到）。
        // 因此必须看返回值：modified === false 才是「已经被人用掉了」。
        return !!(r && r.modified !== false);
      } catch (e) {
        return false;
      }
    },
  };
}

export default async (req) => {
  let body = null;
  if (String(req.method).toUpperCase() === 'POST') {
    try {
      body = await req.json();
    } catch (e) {
      body = null;
    }
  }
  return handleActivate(
    { method: req.method, body, ua: req.headers.get('user-agent') || '', verify: LIC.check },
    blobsLedger(),
  );
};

export const config = { path: '/api/license/activate' };
