/* 账号与每日配额（Netlify 适配层）。
 *
 * 判定逻辑全在 account-core.mjs，与 server.js 的本地实现共用同一份。
 *
 * 数据布局（store 'acct'）：
 *   u/<id>            → 用户档案（含 PBKDF2 盐与摘要）
 *   e/<emailLower>    → 邮箱到 id 的索引
 *   d/<id>/<dayKey>   → 当日已用秒数
 *   lic:used/<serial> → 激活码核销标记（含绑定的账号 id）
 *
 * 密钥：ECHOLINGO_SECRET 必须由环境变量提供。仓库是公开的，
 * 密钥写进代码等于人人可伪造登录凭据，所以缺变量时直接抛错。
 */
import { getStore } from '@netlify/blobs';
import { handleAccount } from './account-core.mjs';
import LIC from '../../app/js/license.js';

const STORE = 'acct';

function blobsDb() {
  const store = getStore(STORE);
  return {
    async get(key) {
      try {
        return await store.get(key, { type: 'json' });
      } catch (e) {
        return null;
      }
    },
    async set(key, value) {
      await store.setJSON(key, value);
      return true;
    },
    async setIfNew(key, value) {
      try {
        const r = await store.setJSON(key, value, { onlyIfNew: true });
        // onlyIfNew 在键已存在时不抛异常，而是返回 { modified: false }。
        // 只按「抛错 = 被占用」判断会静默放行重复写入（以前踩过这个坑）。
        return !!(r && r.modified !== false);
      } catch (e) {
        return false;
      }
    },
    /* Blobs 没有原子自增，这里用读-改-写。并发上报可能丢几秒（对用户有利的方向），
     * 配额本身是「拦普通用户」的松紧带，不必为几秒上分布式锁。 */
    async incr(key, delta) {
      const cur = Number(await this.get(key)) || 0;
      const next = cur + Math.max(0, Number(delta) || 0);
      await store.setJSON(key, next);
      return next;
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
  return handleAccount(
    { method: req.method, body },
    blobsDb(),
    { secret: process.env.ECHOLINGO_SECRET || '', verifyCode: LIC.check },
  );
};

export const config = { path: '/api/account' };
